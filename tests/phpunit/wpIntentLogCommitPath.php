<?php
/**
 * Tests for the rules of the intent-log engine's commit path on the
 * server: what happens when a tab's rows arrive, with more than one
 * process writing to a room.
 *
 * - The engine never uses a copy of a room that another process has
 *   changed since.
 * - A snapshot does not throw away the recent history.
 * - Every row gets one answer, a bad row is refused by itself, and a
 *   row sent again gets its first answer.
 * - The body of an inserted block is checked fully.
 * - The server checks who may decide a review item.
 * - Everything that changes a room's rows holds the room's lock.
 *
 * Most of these tests began as proof of a defect, so many of them say
 * what once went wrong.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogCommitPath extends WP_UnitTestCase {
	const POST_CONTENT = "<!-- wp:paragraph -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->";

	/**
	 * Editor user ID.
	 *
	 * @var int
	 */
	protected static $editor_id;

	/**
	 * A second editor's user ID.
	 *
	 * @var int
	 */
	protected static $other_editor_id;

	/**
	 * Every socket a test opened, closed in tear_down().
	 *
	 * @var resource[]
	 */
	private $sockets = array();

	public static function wpSetUpBeforeClass( WP_UnitTest_Factory $factory ) {
		self::$editor_id       = $factory->user->create( array( 'role' => 'editor' ) );
		self::$other_editor_id = $factory->user->create( array( 'role' => 'editor' ) );
	}

	public static function wpTearDownAfterClass() {
		self::delete_user( self::$editor_id );
		self::delete_user( self::$other_editor_id );
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::$editor_id );
	}

	public function tear_down() {
		foreach ( $this->sockets as $socket ) {
			if ( is_resource( $socket ) ) {
				fclose( $socket );
			}
		}
		$this->sockets = array();

		Commit_Path_Lock_Backend::$events = array();
		Commit_Path_Lock_Backend::$busy   = false;
		WP_Sync_Room_Lock::reset_backend_for_testing();

		parent::tear_down();
	}

	/*
	 * Helpers: rooms, edits, and stored rows.
	 */

	/**
	 * A new engine over a new storage, as a web request builds one.
	 *
	 * @return WP_Intent_Log_Engine Engine.
	 */
	private static function engine(): WP_Intent_Log_Engine {
		return new WP_Intent_Log_Engine( new WP_Sync_Table_Storage() );
	}

	/**
	 * Creates a post with one paragraph. The room is not opened yet.
	 *
	 * @return array{int, string, string} Post id, room name, paragraph id.
	 */
	private function make_post(): array {
		$post_id = self::factory()->post->create(
			array(
				'post_author'  => self::$editor_id,
				'post_content' => self::POST_CONTENT,
			)
		);

		return array(
			$post_id,
			'postType/post:' . $post_id,
			WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array( 0 ) ),
		);
	}

	/**
	 * Creates a post and opens its room, so the first document is stored.
	 *
	 * @return array{int, string, string} Post id, room name, paragraph id.
	 */
	private function make_room(): array {
		$made = $this->make_post();
		self::engine()->get_updates_since( $made[1], 900, 0, array() );
		$this->assertCount( 1, self::stored_rows( $made[1], WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT ) );

		return $made;
	}

	/**
	 * Builds one edit row.
	 *
	 * @param string $id       Edit id.
	 * @param int    $base_seq The position the edit was made against.
	 * @param string $type     Edit type.
	 * @param array  $payload  Edit payload.
	 * @return array Typed update.
	 */
	private static function edit( string $id, int $base_seq, string $type, array $payload ): array {
		return array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
			'data' => wp_json_encode(
				array(
					'intentId' => $id,
					'baseSeq'  => $base_seq,
					'txnId'    => null,
					'type'     => $type,
					'payload'  => $payload,
				)
			),
		);
	}

	/**
	 * An edit that sets the paragraph's `align` attribute. Two of these
	 * made against the same position are a conflict a person must decide.
	 *
	 * @param string $id       Edit id.
	 * @param string $block    Block id.
	 * @param string $value    New value.
	 * @param int    $base_seq The position the edit was made against.
	 * @return array Typed update.
	 */
	private static function align_edit( string $id, string $block, string $value, int $base_seq = 0 ): array {
		return self::edit(
			$id,
			$base_seq,
			'set_attr',
			array(
				'syncId'          => $block,
				'key'             => 'align',
				'value'           => $value,
				'observedVersion' => 0,
			)
		);
	}

	/**
	 * An edit that types text into the paragraph.
	 *
	 * @param string $id       Edit id.
	 * @param string $block    Block id.
	 * @param int    $offset   Where the text goes.
	 * @param string $text     The text.
	 * @param int    $base_seq The position the edit was made against.
	 * @return array Typed update.
	 */
	private static function text_edit( string $id, string $block, int $offset, string $text, int $base_seq ): array {
		return self::edit(
			$id,
			$base_seq,
			'insert_text',
			array(
				'syncId' => $block,
				'field'  => 'content',
				'offset' => $offset,
				'text'   => $text,
			)
		);
	}

	/**
	 * An edit that inserts a new block after the paragraph.
	 *
	 * @param string $id    Edit id.
	 * @param string $after The block to insert after.
	 * @param array  $block The new block's body.
	 * @return array Typed update.
	 */
	private static function insert_edit( string $id, string $after, array $block ): array {
		return self::edit(
			$id,
			0,
			'insert_block',
			array(
				'block'          => array_merge(
					array(
						'syncId'    => 'new-' . $id,
						'blockType' => 'core/paragraph',
					),
					$block
				),
				'parentId'       => null,
				'afterSiblingId' => $after,
			)
		);
	}

	/**
	 * Sends rows to an engine as one request.
	 *
	 * @param WP_Intent_Log_Engine $engine    Engine.
	 * @param string               $room      Room name.
	 * @param int                  $client_id Sending tab.
	 * @param array                $updates   Typed updates.
	 * @return array|WP_Error The engine's answer.
	 */
	private static function commit( WP_Intent_Log_Engine $engine, string $room, int $client_id, array $updates ) {
		return $engine->handle_updates( $room, $client_id, 0, $updates, array() );
	}

	/**
	 * The verdict for one edit id in an engine's answer.
	 *
	 * @param array|WP_Error $answer The engine's answer.
	 * @param string         $id     Edit id.
	 * @return array|null The verdict without its id, or null when absent.
	 */
	private static function verdict( $answer, string $id ): ?array {
		if ( is_wp_error( $answer ) ) {
			return null;
		}
		foreach ( $answer['dispositions'] ?? array() as $disposition ) {
			$answered_id = $disposition['intentId'] ?? null;
			if ( $answered_id === $id ) {
				unset( $disposition['intentId'] );
				return $disposition;
			}
		}

		return null;
	}

	/**
	 * The room's stored rows of one type, read the way a new request does.
	 *
	 * @param string $room Room name.
	 * @param string $type Row type.
	 * @return array[] Decoded rows.
	 */
	private static function stored_rows( string $room, string $type ): array {
		$rows = array();
		foreach ( ( new WP_Sync_Table_Storage() )->get_updates_after_cursor( $room, 0 ) as $row ) {
			if ( $type === $row['type'] ) {
				$rows[] = json_decode( $row['data'], true );
			}
		}

		return $rows;
	}

	/**
	 * The ids of the room's stored edits.
	 *
	 * @param string $room Room name.
	 * @return string[] Edit ids.
	 */
	private static function stored_edit_ids( string $room ): array {
		return array_column( self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_INTENT ), 'intentId' );
	}

	/*
	 * Helpers: the real daemon class, driven without a network.
	 */

	/**
	 * Builds the daemon the way `wp sync-server` does.
	 *
	 * @return WP_WebSocket_Sync_Server The daemon.
	 */
	private function daemon(): WP_WebSocket_Sync_Server {
		return new WP_WebSocket_Sync_Server(
			new WP_RTC_HTTP_Polling_Sync_Server( new WP_Sync_Table_Storage() )
		);
	}

	/**
	 * Connects one tab to the daemon over a socket pair. The handshake is
	 * skipped: the connection is marked open and bound to the user.
	 *
	 * @param WP_WebSocket_Sync_Server $daemon  The daemon.
	 * @param int                      $user_id The tab's user.
	 * @return array{int, resource} The daemon's key for the tab, and the
	 *                              tab's end of the socket.
	 */
	private function open_tab( WP_WebSocket_Sync_Server $daemon, int $user_id ): array {
		$pair = stream_socket_pair( STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP );
		stream_set_blocking( $pair[1], false );
		$this->sockets[] = $pair[0];
		$this->sockets[] = $pair[1];

		$conn      = new WP_WebSocket_Connection( $pair[0] );
		$mark_open = new ReflectionMethod( WP_Sync_Connection::class, 'mark_open' );
		$mark_open->setAccessible( true );
		$mark_open->invoke( $conn );

		$property = new ReflectionProperty( WP_WebSocket_Sync_Server::class, 'clients' );
		$property->setAccessible( true );
		$clients                   = $property->getValue( $daemon );
		$clients[ (int) $pair[0] ] = array(
			'advisory'      => array(),
			'closing'       => false,
			'conn'          => $conn,
			'connected_at'  => microtime( true ),
			'cookie'        => '',
			'ip'            => '127.0.0.1',
			'last_seen'     => microtime( true ),
			'message_times' => array(),
			'request'       => null,
			'rooms'         => array(),
			'user_id'       => $user_id,
		);
		$property->setValue( $daemon, $clients );

		return array( (int) $pair[0], $pair[1] );
	}

	/**
	 * Sends one room request from a tab and returns the daemon's answer
	 * for that room.
	 *
	 * @param WP_WebSocket_Sync_Server $daemon       The daemon.
	 * @param array{int, resource}     $tab          From open_tab().
	 * @param array                    $room_request Room, client id, and
	 *                                               the optional parts.
	 * @return array The room's answer.
	 */
	private function tab_sends( WP_WebSocket_Sync_Server $daemon, array $tab, array $room_request ): array {
		$room_request = array_merge(
			array(
				'after'     => 0,
				'awareness' => array( 'user' => 'test' ),
				'updates'   => array(),
			),
			$room_request
		);

		$handle_message = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'handle_message' );
		$handle_message->setAccessible( true );
		$handle_message->invoke(
			$daemon,
			$tab[0],
			wp_json_encode(
				array(
					'type'  => 'sync',
					'rooms' => array( $room_request ),
				)
			)
		);

		// Read the frames the daemon wrote. Its frames are not masked.
		$bytes    = (string) stream_get_contents( $tab[1] );
		$messages = array();
		$offset   = 0;
		$total    = strlen( $bytes );
		while ( $offset + 2 <= $total ) {
			$opcode  = ord( $bytes[ $offset ] ) & 0x0F;
			$length  = ord( $bytes[ $offset + 1 ] ) & 0x7F;
			$offset += 2;
			if ( 126 === $length ) {
				$length  = unpack( 'n', substr( $bytes, $offset, 2 ) )[1];
				$offset += 2;
			} elseif ( 127 === $length ) {
				$length  = unpack( 'J', substr( $bytes, $offset, 8 ) )[1];
				$offset += 8;
			}
			if ( WP_WebSocket_Connection::OPCODE_TEXT === $opcode ) {
				$messages[] = json_decode( substr( $bytes, $offset, $length ), true );
			}
			$offset += $length;
		}

		$this->assertCount( 1, $messages, 'The daemon answers a request with one message.' );
		$this->assertSame( 'sync', $messages[0]['type'], 'The daemon answered with an error: ' . wp_json_encode( $messages[0] ) );

		return $messages[0]['rooms'][0];
	}

	/**
	 * Closes a tab's socket on the daemon's side, as the daemon does when
	 * the browser goes away.
	 *
	 * @param WP_WebSocket_Sync_Server $daemon The daemon.
	 * @param array{int, resource}     $tab    From open_tab().
	 */
	private function tab_leaves( WP_WebSocket_Sync_Server $daemon, array $tab ): void {
		$disconnect = new ReflectionMethod( WP_WebSocket_Sync_Server::class, 'disconnect' );
		$disconnect->setAccessible( true );
		$disconnect->invoke( $daemon, $tab[0] );
	}

	/**
	 * One room request through a new polling server, as a web request
	 * from another process makes it.
	 *
	 * @param array $room_request Room, client id, and the optional parts.
	 * @return array|WP_Error The room's answer.
	 */
	private static function polling_request( array $room_request ) {
		$server = new WP_RTC_HTTP_Polling_Sync_Server( new WP_Sync_Table_Storage() );

		return $server->process_room_request(
			array_merge(
				array(
					'after'     => 0,
					'awareness' => array( 'user' => 'test' ),
					'updates'   => array(),
				),
				$room_request
			)
		);
	}

	/*
	 * The engine never uses a copy of a room that another process has
	 * changed since.
	 */

	/**
	 * Opens a room on the daemon with one tab, then lets another process
	 * store an edit to the paragraph's `align` attribute.
	 *
	 * @return array{WP_WebSocket_Sync_Server, array, string, string} The
	 *         daemon, the tab, the room name, the paragraph id.
	 */
	private function daemon_room_another_process_wrote_to(): array {
		list( , $room, $block ) = $this->make_post();
		$daemon                 = $this->daemon();
		$tab                    = $this->open_tab( $daemon, self::$editor_id );

		// The daemon's first read of the room.
		$first = $this->tab_sends(
			$daemon,
			$tab,
			array(
				'room'      => $room,
				'client_id' => 101,
			)
		);
		$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $first['updates'][0]['type'] );

		// A polling tab writes through an ordinary web request.
		$polled = self::polling_request(
			array(
				'room'      => $room,
				'client_id' => 202,
				'updates'   => array( self::align_edit( 'poll-1', $block, 'wide' ) ),
			)
		);
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $polled, 'poll-1' ) );

		return array( $daemon, $tab, $room, $block );
	}

	/**
	 * The daemon keeps one engine object for its whole life. After another
	 * process writes to a room, the daemon's next commit must be combined
	 * with that write. Once it was combined against the copy the daemon's
	 * first read had loaded, so a clash with the other process's edit was
	 * missed and the edit was applied over it with nobody told.
	 */
	public function test_daemon_combines_an_edit_with_what_another_process_wrote_since_its_first_read() {
		list( $daemon, $tab, $room, $block ) = $this->daemon_room_another_process_wrote_to();

		// The WebSocket tab changes the same attribute, not having seen
		// the polling tab's edit.
		$answer = $this->tab_sends(
			$daemon,
			$tab,
			array(
				'room'      => $room,
				'client_id' => 101,
				'updates'   => array( self::align_edit( 'ws-1', $block, 'full' ) ),
			)
		);

		$this->assertSame(
			array(
				'status' => 'escalated',
				'reason' => 'attr-conflict',
			),
			self::verdict( $answer, 'ws-1' ),
			'Two edits to one attribute from the same position are a conflict for a person to decide.'
		);
	}

	/**
	 * An edit the WebSocket tab made after it received the other process's
	 * edit is a normal edit. Against an old copy of the room it named a
	 * position past the end and was refused as `invalid-payload`.
	 */
	public function test_daemon_accepts_an_edit_based_on_what_another_process_wrote_since_its_first_read() {
		list( $daemon, $tab, $room, $block ) = $this->daemon_room_another_process_wrote_to();

		// The WebSocket tab has received the polling tab's edit, so its
		// next edit is based on position 1.
		$answer = $this->tab_sends(
			$daemon,
			$tab,
			array(
				'room'      => $room,
				'client_id' => 101,
				'updates'   => array( self::text_edit( 'ws-1', $block, 0, 'x', 1 ) ),
			)
		);

		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'ws-1' ) );
	}

	/**
	 * A commit that fails midway leaves the engine object holding the copy
	 * of the room it loaded. The next commit on the same object (the
	 * daemon's, for example, when the tab tries again) must still see what
	 * another process wrote meanwhile.
	 */
	public function test_commit_after_a_failed_commit_sees_what_another_process_wrote() {
		list( , $room, $block ) = $this->make_room();

		// One long-lived engine. Its first use of the room is a commit
		// whose write the storage refuses.
		$storage                = new Commit_Path_Refusing_Storage();
		$long_lived             = new WP_Intent_Log_Engine( $storage );
		$storage->refuse_writes = 1;
		$failed                 = self::commit( $long_lived, $room, 101, array( self::text_edit( 'a-fail', $block, 0, 'x', 0 ) ) );
		$this->assertWPError( $failed );
		$this->assertSame( 'rest_sync_storage_error', $failed->get_error_code() );
		$this->assertSame( array(), self::stored_edit_ids( $room ) );

		// Another process stores an edit.
		$other = self::commit( self::engine(), $room, 202, array( self::align_edit( 'b-1', $block, 'wide' ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $other, 'b-1' ) );

		// The long-lived engine commits again. The storage works now.
		$answer = self::commit( $long_lived, $room, 101, array( self::align_edit( 'a-1', $block, 'full' ) ) );

		$this->assertSame(
			array(
				'status' => 'escalated',
				'reason' => 'attr-conflict',
			),
			self::verdict( $answer, 'a-1' ),
			'Two edits to one attribute from the same position are a conflict for a person to decide.'
		);
	}

	/**
	 * A script save reads the room with no lock, then commits under the
	 * lock. An edit that another request stores between the two steps
	 * must be seen by the commit, so a clash goes to review and the
	 * script's change does not replace the other edit with nobody told.
	 */
	public function test_script_save_sees_an_edit_that_arrives_between_its_read_and_its_commit() {
		list( $post_id, $room, $block ) = $this->make_room();
		WP_Intent_Log_Base_Seq_Preflight::register();

		/*
		 * The script save reads the room, then parses the saved content,
		 * then commits. The block parser filter runs in that parse, so it
		 * is the place to let another request's edit arrive. It is armed
		 * right before the save's own hook, and fires once.
		 */
		$arrived     = false;
		$other_saves = function ( $parser_class ) use ( &$arrived, &$other_saves, $room, $block ) {
			remove_filter( 'block_parser_class', $other_saves );
			$arrived = true;
			$answer  = self::commit( self::engine(), $room, 301, array( self::align_edit( 'session-1', $block, 'wide' ) ) );
			$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'session-1' ) );

			return $parser_class;
		};
		$arm         = static function ( $maybe_empty ) use ( &$arm, $other_saves ) {
			remove_filter( 'wp_insert_post_empty_content', $arm, 9 );
			add_filter( 'block_parser_class', $other_saves );

			return $maybe_empty;
		};
		add_filter( 'wp_insert_post_empty_content', $arm, 9 );

		// The script read the post at position 0 and changes the same
		// attribute the other request changes.
		$updated = wp_update_post(
			array(
				'ID'                  => $post_id,
				'post_content'        => sprintf(
					"<!-- wp:paragraph {\"align\":\"left\",\"metadata\":{\"syncId\":\"%s\"}} -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->",
					$block
				),
				'intent_log_base_seq' => 0,
			),
			true
		);
		$this->assertNotWPError( $updated );
		$this->assertTrue( $arrived, 'The other edit arrived between the read and the commit.' );
		$this->assertSame( array( 'session-1' ), array_slice( self::stored_edit_ids( $room ), 0, 1 ), 'The other edit was stored first.' );

		$statuses = array_column( (array) WP_Intent_Log_Base_Seq_Preflight::last_dispositions(), 'status' );
		$this->assertContains( 'escalated', $statuses, 'The clash is set aside for a person to decide.' );
		$this->assertStringContainsString(
			'"align":"wide"',
			get_post( $post_id )->post_content,
			'The saved post keeps the edit that was stored first.'
		);
	}

	/**
	 * When the last WebSocket tab leaves, the daemon resets the room. The
	 * next tab to open the post over WebSocket must get a first document,
	 * also when the tab that left never typed. Once the engine object kept
	 * its copy of the room across the reset, took the room for loaded, and
	 * answered with nothing.
	 */
	public function test_daemon_gives_a_first_document_to_the_tab_that_opens_a_post_after_the_last_tab_left() {
		list( , $room ) = $this->make_post();
		$daemon         = $this->daemon();

		// A tab opens the post alone, does not type, and leaves.
		$first_tab = $this->open_tab( $daemon, self::$editor_id );
		$first     = $this->tab_sends(
			$daemon,
			$first_tab,
			array(
				'room'           => $room,
				'client_id'      => 101,
				'presence_token' => 'tab-a',
			)
		);
		$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $first['updates'][0]['type'] );
		$this->tab_leaves( $daemon, $first_tab );
		$this->assertSame(
			array(),
			( new WP_Sync_Table_Storage() )->get_updates_after_cursor( $room, 0 ),
			'The last tab leaving reset the room.'
		);

		// The post is opened again.
		$second_tab = $this->open_tab( $daemon, self::$editor_id );
		$second     = $this->tab_sends(
			$daemon,
			$second_tab,
			array(
				'room'           => $room,
				'client_id'      => 102,
				'presence_token' => 'tab-b',
			)
		);

		$this->assertNotEmpty( $second['updates'], 'The new tab gets the first document.' );
		$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $second['updates'][0]['type'] );
	}

	/**
	 * A second way to the same empty answer. The daemon's storage object
	 * remembers the position of the room's newest row. When another
	 * process resets the room (a closing tab's leave beacon goes to the
	 * web server, not to the daemon), that position is out of date. The
	 * engine must not decide from it before a new read, or it builds no
	 * first document and answers the next tab with nothing.
	 */
	public function test_daemon_gives_a_first_document_after_another_process_reset_the_room() {
		list( , $room, $block ) = $this->make_post();
		$daemon                 = $this->daemon();

		// A tab opens the post alone and types one edit.
		$first_tab = $this->open_tab( $daemon, self::$editor_id );
		$first     = $this->tab_sends(
			$daemon,
			$first_tab,
			array(
				'room'           => $room,
				'client_id'      => 101,
				'presence_token' => 'tab-a',
			)
		);
		$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $first['updates'][0]['type'] );
		$typed = $this->tab_sends(
			$daemon,
			$first_tab,
			array(
				'room'           => $room,
				'client_id'      => 101,
				'presence_token' => 'tab-a',
				'after'          => $first['end_cursor'],
				'updates'        => array( self::text_edit( 'ws-1', $block, 0, 'x', 0 ) ),
			)
		);
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $typed, 'ws-1' ) );

		// The tab closes. Its leave beacon reaches the web server first,
		// which resets the room. Then the daemon notices the closed socket.
		$web_presence = new Gutenberg_Sync_Engines_Advisory_Presence( new WP_Sync_Table_Storage() );
		$this->assertTrue( $web_presence->leave( $room, 'tab-a', 101 ), 'The leave beacon reset the room.' );
		$this->tab_leaves( $daemon, $first_tab );

		// The post is opened again.
		$second_tab = $this->open_tab( $daemon, self::$editor_id );
		$second     = $this->tab_sends(
			$daemon,
			$second_tab,
			array(
				'room'           => $room,
				'client_id'      => 102,
				'presence_token' => 'tab-b',
			)
		);

		$this->assertNotEmpty( $second['updates'], 'The new tab gets the first document.' );
		$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $second['updates'][0]['type'] );
	}

	/**
	 * The storages a long-lived engine can sit on.
	 *
	 * @return array[] Data sets: the storage class name.
	 */
	public function data_storages(): array {
		return array(
			'the table storage'    => array( WP_Sync_Table_Storage::class ),
			'the fallback storage' => array( WP_RTC_Post_Meta_Storage::class ),
		);
	}

	/**
	 * A room that was reset and written again can look the same as before
	 * by its number of rows and edits. The engine tells its kept copy
	 * apart by the id of the room's newest row, which never repeats.
	 *
	 * @dataProvider data_storages
	 *
	 * @param string $storage_class Storage class name.
	 */
	public function test_long_lived_engine_sees_a_room_that_was_reset_and_written_again( string $storage_class ) {
		list( , $room, $block ) = $this->make_post();
		$other_process          = static function () use ( $storage_class ) {
			return new WP_Intent_Log_Engine( new $storage_class() );
		};

		// The room holds its first document and one edit to the text.
		$first = self::commit( $other_process(), $room, 202, array( self::text_edit( 'old-1', $block, 0, 'x', 0 ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $first, 'old-1' ) );

		// A long-lived engine loads the room and keeps its copy.
		$long_lived = $other_process();
		$this->assertSame( 1, $long_lived->head_seq( $room ) );

		// Another process resets the room and writes one edit again, this
		// time to the `align` attribute.
		$this->assertTrue( ( new $storage_class() )->reset_room( $room ) );
		$second = self::commit( $other_process(), $room, 202, array( self::align_edit( 'new-1', $block, 'wide' ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $second, 'new-1' ) );

		// The long-lived engine changes the same attribute. Against its old
		// copy there is no clash, because that copy holds the text edit.
		$answer = self::commit( $long_lived, $room, 101, array( self::align_edit( 'a-1', $block, 'full' ) ) );

		$this->assertSame(
			array(
				'status' => 'escalated',
				'reason' => 'attr-conflict',
			),
			self::verdict( $answer, 'a-1' )
		);
	}

	/**
	 * A poll of a room that holds rows reads only the rows after the
	 * tab's position. It never reads the room from its start, however
	 * long the stored history is.
	 */
	public function test_poll_of_a_room_with_history_reads_only_the_new_rows() {
		list( , $room, $block ) = $this->make_room();
		for ( $i = 0; $i < 3; $i++ ) {
			$answer = self::commit( self::engine(), $room, 101, array( self::text_edit( "typed-$i", $block, 0, 'x', $i ) ) );
			$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, "typed-$i" ) );
		}
		$caught_up = self::engine()->get_updates_since( $room, 101, 0, array() );
		$this->assertCount( 4, $caught_up['updates'] );

		// A new request, as every poll is.
		$storage = new Commit_Path_Recording_Storage();
		$poll    = ( new WP_Intent_Log_Engine( $storage ) )->get_updates_since( $room, 101, $caught_up['end_cursor'], array() );

		$this->assertSame( array(), $poll['updates'] );
		$this->assertSame( $caught_up['end_cursor'], $poll['end_cursor'] );
		$this->assertSame( array( $caught_up['end_cursor'] ), $storage->read_after, 'One read, from the position of the tab.' );
	}

	/*
	 * A snapshot does not throw away the recent history.
	 */

	/**
	 * Makes snapshots cheap, then has one tab type three edits, which
	 * writes a snapshot at position 3. The three edit rows stay stored.
	 *
	 * @param string $room  Room name.
	 * @param string $block Paragraph id.
	 * @return array The third edit as it was sent, based on position 2.
	 */
	private function type_three_edits_past_a_snapshot( string $room, string $block ): array {
		// Hooks added in a test are removed again when it ends.
		add_filter(
			'wp_sync_intent_log_checkpoint_interval',
			static function () {
				return 3;
			}
		);

		$sent = array();
		for ( $i = 0; $i < 3; $i++ ) {
			$sent[ $i ] = self::text_edit( "typed-$i", $block, 0, 'x', $i );
			$answer     = self::commit( self::engine(), $room, 101, array( $sent[ $i ] ) );
			$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, "typed-$i" ) );
		}

		$snapshots = self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT );
		$this->assertCount( 2, $snapshots, 'The first document and one snapshot.' );
		$this->assertSame( 3, $snapshots[1]['seq'] );
		$this->assertSame(
			array( 'typed-0', 'typed-1', 'typed-2' ),
			self::stored_edit_ids( $room ),
			'The edits before the snapshot are still stored.'
		);

		return $sent[2];
	}

	/**
	 * An edit that was already on its way when a snapshot was written,
	 * based on a position just before it, is combined like any other
	 * edit: the rows it needs are still stored. Once the engine forgot
	 * every edit before the last snapshot when it loaded a room, and
	 * refused such an edit as `stale-base`.
	 */
	public function test_edit_in_flight_across_a_snapshot_is_combined() {
		list( , $room, $block ) = $this->make_room();
		$this->type_three_edits_past_a_snapshot( $room, $block );

		// A second tab typed at the end of the paragraph when it had seen
		// two of the three edits ("xxHello world", 13 characters).
		$answer = self::commit( self::engine(), $room, 202, array( self::text_edit( 'late-1', $block, 13, '!', 2 ) ) );

		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'late-1' ) );
	}

	/**
	 * The verdicts of the edits before a snapshot are kept as well. An
	 * edit that was applied just before a snapshot and is sent again (its
	 * answer was lost, say) gets its first verdict, `applied`, and not
	 * `stale-base`.
	 */
	public function test_applied_edit_sent_again_after_a_snapshot_gets_its_first_verdict() {
		list( , $room, $block ) = $this->make_room();
		$third                  = $this->type_three_edits_past_a_snapshot( $room, $block );

		$answer = self::commit( self::engine(), $room, 101, array( $third ) );

		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'typed-2' ) );
		$this->assertSame(
			array( 'typed-0', 'typed-1', 'typed-2' ),
			self::stored_edit_ids( $room ),
			'A repeat never stores the edit twice.'
		);
	}

	/**
	 * Keeping the edits before a snapshot must not make snapshots more
	 * frequent: the next one is due a full interval after the last, and
	 * the older rows are then deleted as before. An edit based on a
	 * position whose rows are deleted is still refused as `stale-base`.
	 */
	public function test_snapshots_keep_their_interval_and_edits_below_the_stored_rows_stay_refused() {
		list( , $room, $block ) = $this->make_room();
		$this->type_three_edits_past_a_snapshot( $room, $block );

		// Two more edits: no new snapshot yet.
		for ( $i = 3; $i < 5; $i++ ) {
			$answer = self::commit( self::engine(), $room, 101, array( self::text_edit( "typed-$i", $block, 0, 'x', $i ) ) );
			$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, "typed-$i" ) );
		}
		$this->assertCount( 2, self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT ) );

		// The sixth edit writes the second snapshot, and the rows before
		// the first snapshot are deleted.
		$answer = self::commit( self::engine(), $room, 101, array( self::text_edit( 'typed-5', $block, 0, 'x', 5 ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'typed-5' ) );
		$this->assertSame( array( 3, 6 ), array_column( self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT ), 'seq' ) );
		$this->assertSame( array( 'typed-3', 'typed-4', 'typed-5' ), self::stored_edit_ids( $room ) );

		// The room still loads to the right document and position.
		$this->assertSame( 6, self::engine()->head_seq( $room ) );
		$this->assertStringContainsString( 'xxxxxxHello world', (string) self::engine()->materialize( $room ) );

		// Based on a position whose rows are still stored: combined.
		$kept = self::commit( self::engine(), $room, 202, array( self::text_edit( 'late-kept', $block, 15, '!', 4 ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $kept, 'late-kept' ) );
		$this->assertStringContainsString( 'xxxxxxHello world!', (string) self::engine()->materialize( $room ) );

		// Based on a position whose rows are gone: refused.
		$gone = self::commit( self::engine(), $room, 202, array( self::text_edit( 'late-gone', $block, 13, '?', 2 ) ) );
		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'stale-base',
			),
			self::verdict( $gone, 'late-gone' )
		);
	}

	/*
	 * Every row gets one answer, and a bad row is refused by itself.
	 */

	/**
	 * A row whose edit id cannot be read is refused by its place in the
	 * request, counted from 0, so the sender learns which row it was.
	 */
	public function test_row_with_no_usable_edit_id_gets_an_answer() {
		list( , $room, $block ) = $this->make_room();

		$updates = array(
			// No edit id at all.
			array(
				'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
				'data' => wp_json_encode(
					array(
						'baseSeq' => 0,
						'type'    => 'insert_text',
						'payload' => array(),
					)
				),
			),
			// Not JSON.
			array(
				'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
				'data' => 'not json',
			),
			self::text_edit( 'good-1', $block, 0, 'x', 0 ),
		);
		$answer = self::commit( self::engine(), $room, 101, $updates );

		$this->assertNotWPError( $answer );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'good-1' ) );

		$this->assertCount( count( $updates ), $answer['dispositions'], 'Every row sent gets a verdict.' );
		$this->assertSame(
			array(
				array(
					'row'    => 0,
					'status' => 'voided',
					'reason' => 'invalid-payload',
				),
				array(
					'row'    => 1,
					'status' => 'voided',
					'reason' => 'invalid-payload',
				),
				array(
					'intentId' => 'good-1',
					'status'   => 'applied',
				),
			),
			$answer['dispositions'],
			'The answers come in the order the rows were sent.'
		);
	}

	/**
	 * Rows the engine cannot accept, each sent together with a good edit.
	 *
	 * @return array[] Data sets: the bad row, and the answer it gets.
	 */
	public function data_bad_rows_beside_a_good_edit(): array {
		return array(
			'a bad `resolved` row'      => array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED,
					'data' => wp_json_encode(
						array(
							'proposalId' => 'p-1',
							'resolution' => 'not-a-decision',
						)
					),
				),
				array(
					'intentId' => 'p-1',
					'status'   => 'voided',
					'reason'   => 'invalid-payload',
				),
			),
			'a bad `cancel` row'        => array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_CANCEL,
					'data' => wp_json_encode( array( 'cancelId' => 'c-1' ) ),
				),
				array(
					'intentId' => 'c-1',
					'status'   => 'voided',
					'reason'   => 'invalid-payload',
				),
			),
			'a row of a type not taken' => array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT,
					'data' => wp_json_encode( array( 'doc' => array( 'root' => array() ) ) ),
				),
				array(
					'row'    => 0,
					'status' => 'voided',
					'reason' => 'invalid-type',
				),
			),
		);
	}

	/**
	 * One bad `resolved` or `cancel` row, or a row of a type a tab may
	 * not send, is refused by itself. A good edit sent in the same
	 * request is stored. Once such a row failed the whole request with
	 * a 400.
	 *
	 * @dataProvider data_bad_rows_beside_a_good_edit
	 *
	 * @param array $bad_row The row the engine cannot accept.
	 * @param array $refusal The answer the bad row gets.
	 */
	public function test_bad_row_does_not_stop_a_good_edit_in_the_same_request( array $bad_row, array $refusal ) {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array( $bad_row, self::text_edit( 'good-1', $block, 0, 'x', 0 ) )
		);

		$this->assertNotWPError( $answer, 'The request as a whole is answered.' );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'good-1' ) );
		$this->assertSame( array( 'good-1' ), self::stored_edit_ids( $room ) );
		$this->assertSame( $refusal, $answer['dispositions'][0] );
	}

	/**
	 * A request that holds only rows the engine cannot accept is answered
	 * like any other, with one refusal per row. Nothing is stored.
	 *
	 * @dataProvider data_bad_rows_beside_a_good_edit
	 *
	 * @param array $bad_row The row the engine cannot accept.
	 * @param array $refusal The answer the bad row gets.
	 */
	public function test_request_of_only_bad_rows_is_answered_row_by_row( array $bad_row, array $refusal ) {
		list( , $room ) = $this->make_room();

		$answer = self::polling_request(
			array(
				'room'      => $room,
				'client_id' => 101,
				'updates'   => array( $bad_row, $bad_row ),
			)
		);

		$this->assertNotWPError( $answer );
		$second = $refusal;
		if ( isset( $second['row'] ) ) {
			$second['row'] = 1;
		}
		$this->assertSame( array( $refusal, $second ), $answer['dispositions'] );
		$this->assertCount( 1, ( new WP_Sync_Table_Storage() )->get_updates_after_cursor( $room, 0 ), 'Only the first document is stored.' );
	}

	/**
	 * The `invalid-payload` verdict is stored, so the very same row sent
	 * again later gets the same answer. Here the row is refused because
	 * its base is past the end of the history. Without the stored verdict
	 * the repeat would be applied, once the history has grown.
	 */
	public function test_refused_edit_sent_again_gets_the_same_verdict() {
		list( , $room, $block ) = $this->make_room();

		$row   = self::text_edit( 'early-1', $block, 0, 'x', 1 );
		$first = self::commit( self::engine(), $room, 101, array( $row ) );
		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'invalid-payload',
			),
			self::verdict( $first, 'early-1' )
		);

		// Another tab's edit makes the history one edit long.
		$other = self::commit( self::engine(), $room, 202, array( self::align_edit( 'b-1', $block, 'wide' ) ) );
		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $other, 'b-1' ) );

		$again = self::commit( self::engine(), $room, 101, array( $row ) );

		$this->assertSame( self::verdict( $first, 'early-1' ), self::verdict( $again, 'early-1' ) );
		$this->assertSame(
			array(
				array(
					'intentId' => 'early-1',
					'reason'   => 'invalid-payload',
				),
			),
			self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_VOIDED ),
			'The refusal is stored once, however often the row is sent.'
		);
		$this->assertSame( array( 'b-1' ), self::stored_edit_ids( $room ) );
	}

	/**
	 * The first row with an edit id decides for that id, also inside one
	 * request: a good row that follows a malformed row with the same id
	 * gets the refusal and is not stored.
	 */
	public function test_first_row_with_an_edit_id_decides_inside_one_request() {
		list( , $room, $block ) = $this->make_room();

		$malformed = self::edit( 'twice-1', 0, 'insert_text', array() );
		$good      = self::text_edit( 'twice-1', $block, 0, 'x', 0 );
		$answer    = self::commit( self::engine(), $room, 101, array( $malformed, $good ) );

		$refusal = array(
			'intentId' => 'twice-1',
			'status'   => 'voided',
			'reason'   => 'invalid-payload',
		);
		$this->assertSame( array( $refusal, $refusal ), $answer['dispositions'] );
		$this->assertSame( array(), self::stored_edit_ids( $room ) );

		// The other way round, the good row decides.
		$answer = self::commit( self::engine(), $room, 101, array( self::text_edit( 'twice-2', $block, 0, 'x', 0 ), self::edit( 'twice-2', 0, 'insert_text', array() ) ) );

		$applied = array(
			'intentId' => 'twice-2',
			'status'   => 'applied',
		);
		$this->assertSame( array( $applied, $applied ), $answer['dispositions'] );
		$this->assertSame( array( 'twice-2' ), self::stored_edit_ids( $room ) );
	}

	/**
	 * An edit refused as `stale-base` gets the same answer when it is
	 * sent again, with no stored marker: the start of the stored history
	 * only moves forward. A marker row would reach the author's tab
	 * before the answer and settle the edit there before the tab has
	 * recovered its text.
	 */
	public function test_stale_edit_sent_again_gets_the_same_verdict_without_a_stored_marker() {
		list( , $room, $block ) = $this->make_room();
		$this->type_three_edits_past_a_snapshot( $room, $block );
		for ( $i = 3; $i < 6; $i++ ) {
			self::commit( self::engine(), $room, 101, array( self::text_edit( "typed-$i", $block, 0, 'x', $i ) ) );
		}

		$row   = self::text_edit( 'late-gone', $block, 13, '?', 2 );
		$stale = array(
			'status' => 'voided',
			'reason' => 'stale-base',
		);
		$this->assertSame( $stale, self::verdict( self::commit( self::engine(), $room, 202, array( $row ) ), 'late-gone' ) );

		self::commit( self::engine(), $room, 101, array( self::text_edit( 'typed-6', $block, 0, 'x', 6 ) ) );

		$this->assertSame( $stale, self::verdict( self::commit( self::engine(), $room, 202, array( $row ) ), 'late-gone' ) );
		$this->assertSame( array(), self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_VOIDED ) );
	}

	/*
	 * The body of an inserted block is checked fully.
	 */

	/**
	 * An inserted block whose text is not a string is refused. Once only
	 * the id, type and children of an inserted block were checked, and
	 * such an edit was applied and stored as sent.
	 */
	public function test_inserted_block_with_text_of_the_wrong_type_is_refused() {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array(
				self::insert_edit(
					'bad-text',
					$block,
					array( 'fields' => array( 'content' => array( 'text' => 42 ) ) )
				),
			)
		);

		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'invalid-payload',
			),
			self::verdict( $answer, 'bad-text' )
		);
		$this->assertSame( array(), self::stored_edit_ids( $room ) );
	}

	/**
	 * An inserted block whose formats are not a list is refused. Once it
	 * made the engine raise a TypeError while it combined the edit, which
	 * nothing in the daemon catches.
	 */
	public function test_inserted_block_with_formats_of_the_wrong_type_is_refused_without_an_error() {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array(
				self::insert_edit(
					'bad-formats',
					$block,
					array(
						'fields' => array(
							'content' => array(
								'text'    => 'x',
								'formats' => 'bold',
							),
						),
					)
				),
			)
		);
		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'invalid-payload',
			),
			self::verdict( $answer, 'bad-formats' )
		);
	}

	/**
	 * An inserted block whose attributes are not a map is refused. Once
	 * it was applied and stored, and from then on the room could not be
	 * turned into post content: materialize() raised an Error on every
	 * call, which broke every later script save of that post.
	 */
	public function test_inserted_block_with_attributes_of_the_wrong_type_does_not_break_the_room() {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array( self::insert_edit( 'bad-attrs', $block, array( 'attrs' => 'not a map' ) ) )
		);
		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'invalid-payload',
			),
			self::verdict( $answer, 'bad-attrs' )
		);

		$this->assertStringContainsString( 'Hello world', (string) self::engine()->materialize( $room ) );
	}

	/**
	 * More block bodies that cannot be stored.
	 *
	 * @return array[] Data sets: the parts of the block beside its id and type.
	 */
	public function data_unusable_block_bodies(): array {
		$bold = array(
			'start'  => 0,
			'end'    => 1,
			'format' => 'strong',
		);

		return array(
			'a field that is not a map'                   => array( array( 'fields' => array( 'content' => 'text' ) ) ),
			'fields that are a list'                      => array( array( 'fields' => array( array( 'text' => 'x' ) ) ) ),
			'a format that is not a range'                => array( array( 'fields' => array( 'content' => array( 'formats' => array( 'strong' ) ) ) ) ),
			'a range that ends before it starts'          => array( array( 'fields' => array( 'content' => array( 'formats' => array( array_merge( $bold, array( 'start' => 2 ) ) ) ) ) ) ),
			'a range with a format of a wrong type'       => array( array( 'fields' => array( 'content' => array( 'formats' => array( array_merge( $bold, array( 'format' => 7 ) ) ) ) ) ) ),
			'the short form with text of a wrong type'    => array( array( 'text' => array( 'x' ) ) ),
			'the short form with formats of a wrong type' => array( array( 'formats' => 'strong' ) ),
			'attribute versions that are not numbers'     => array( array( 'attrVersions' => array( 'align' => 'one' ) ) ),
			'children that are not a list'                => array( array( 'children' => 'none' ) ),
			'a child with a bad body'                     => array(
				array(
					'children' => array(
						array(
							'syncId'    => 'child-1',
							'blockType' => 'core/paragraph',
							'attrs'     => 'not a map',
						),
					),
				),
			),
		);
	}

	/**
	 * @dataProvider data_unusable_block_bodies
	 *
	 * @param array $body The parts of the block beside its id and type.
	 */
	public function test_inserted_block_with_an_unusable_body_is_refused( array $body ) {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit( self::engine(), $room, 101, array( self::insert_edit( 'bad-body', $block, $body ) ) );

		$this->assertSame(
			array(
				'status' => 'voided',
				'reason' => 'invalid-payload',
			),
			self::verdict( $answer, 'bad-body' )
		);
		$this->assertSame( array(), self::stored_edit_ids( $room ) );
	}

	/**
	 * The check does not get in the way of a block as an editor sends it:
	 * fields with formats, attributes of any shape, and children.
	 */
	public function test_inserted_block_with_a_full_body_is_applied() {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array(
				self::insert_edit(
					'full-1',
					$block,
					array(
						'blockType' => 'core/quote',
						'attrs'     => array(
							'align' => 'wide',
							'style' => array( 'color' => array( 'text' => '#000' ) ),
							'list'  => array( 'a', 'b' ),
						),
						'fields'    => array(
							'content'  => array(
								'text'    => 'Quoted',
								'formats' => array(
									array(
										'start'  => 0,
										'end'    => 6,
										'format' => 'strong',
									),
								),
							),
							'citation' => array( 'text' => 'Someone' ),
						),
						'children'  => array(
							array(
								'syncId'    => 'full-1-child',
								'blockType' => 'core/paragraph',
								'attrs'     => array(),
								'fields'    => array(
									'content' => array(
										'text'    => 'Inner',
										'formats' => array(),
									),
								),
								'children'  => array(),
							),
						),
					)
				),
			)
		);

		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'full-1' ) );
		$content = (string) self::engine()->materialize( $room );
		$this->assertStringContainsString( '<strong>Quoted</strong>', $content );
		$this->assertStringContainsString( 'Inner', $content );
	}

	/*
	 * The server checks who may decide a review item.
	 */

	/**
	 * Holds an edit for approval: its author may not publish its markup.
	 * In the test only the given user may publish unfiltered HTML.
	 *
	 * @param string $room       Room name.
	 * @param string $block      Paragraph id.
	 * @param int    $privileged The one user who may publish unfiltered HTML.
	 */
	private function hold_an_edit_for_approval( string $room, string $block, int $privileged ): void {
		add_filter(
			'map_meta_cap',
			static function ( $caps, $cap, $user_id ) use ( $privileged ) {
				if ( 'unfiltered_html' === $cap && $user_id !== $privileged ) {
					return array( 'do_not_allow' );
				}

				return $caps;
			},
			10,
			3
		);
		$this->assertFalse( current_user_can( 'unfiltered_html' ) );

		// The author inserts a block that carries a script.
		$held = self::commit(
			self::engine(),
			$room,
			101,
			array(
				self::insert_edit(
					'held-1',
					$block,
					array(
						'fields' => array(
							'content' => array(
								'text'    => "\u{FFFC}",
								'formats' => array(
									array(
										'start'  => 0,
										'end'    => 1,
										'format' => 'obj|' . wp_json_encode( array( 'html' => '<script>alert(1)</script>' ), JSON_UNESCAPED_SLASHES ),
									),
								),
							),
						),
					)
				),
			)
		);
		$this->assertSame(
			array(
				'status' => 'escalated',
				'reason' => WP_Intent_Log_Engine::ESCALATION_REQUIRES_APPROVAL,
			),
			self::verdict( $held, 'held-1' )
		);
	}

	/**
	 * One review decision row.
	 *
	 * @param string $proposal_id The review item.
	 * @param string $resolution  `restored` (approve) or `dismissed`.
	 * @return array Typed update.
	 */
	private static function decision( string $proposal_id, string $resolution ): array {
		return array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED,
			'data' => wp_json_encode(
				array(
					'proposalId' => $proposal_id,
					'resolution' => $resolution,
				)
			),
		);
	}

	/**
	 * Who may decide an edit held for approval.
	 *
	 * @return array[] Data sets: who decides, the decision, whether it is allowed.
	 */
	public function data_decisions_on_a_held_edit(): array {
		return array(
			'another editor without the right approves'  => array( 'other', 'restored', false ),
			'another editor without the right dismisses' => array( 'other', 'dismissed', false ),
			'the author approves'                        => array( 'author', 'restored', false ),
			'the author dismisses'                       => array( 'author', 'dismissed', true ),
			'someone with the right approves'            => array( 'privileged', 'restored', true ),
			'someone with the right dismisses'           => array( 'privileged', 'dismissed', true ),
		);
	}

	/**
	 * An edit held because its author may not publish its markup (no
	 * `unfiltered_html`) is approved only by a user who may publish it.
	 * It is dismissed by such a user or by its author. Every other
	 * decision is refused, and the item stays open. Once any user who
	 * could edit the post could close any review item.
	 *
	 * The rule is in docs/conflict-review.md, and in the editor's own
	 * text ("Only someone allowed to publish unfiltered HTML can approve
	 * this.").
	 *
	 * @dataProvider data_decisions_on_a_held_edit
	 *
	 * @param string $who        `author`, `other` or `privileged`.
	 * @param string $resolution `restored` (approve) or `dismissed`.
	 * @param bool   $allowed    Whether the decision is allowed.
	 */
	public function test_held_edit_is_decided_only_by_a_user_who_may( string $who, string $resolution, bool $allowed ) {
		list( , $room, $block ) = $this->make_room();
		$privileged             = self::factory()->user->create( array( 'role' => 'editor' ) );
		$this->hold_an_edit_for_approval( $room, $block, $privileged );

		$deciders = array(
			'author'     => self::$editor_id,
			'other'      => self::$other_editor_id,
			'privileged' => $privileged,
		);
		wp_set_current_user( $deciders[ $who ] );
		$this->assertTrue( current_user_can( 'edit_post', (int) substr( $room, strlen( 'postType/post:' ) ) ) );
		$this->assertSame( 'privileged' === $who, current_user_can( 'unfiltered_html' ) );

		// The author decides from the tab that sent the edit, the others
		// from their own.
		$answer = self::commit( self::engine(), $room, 'author' === $who ? 101 : 202, array( self::decision( 'held-1', $resolution ) ) );

		$stored = array_column( self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED ), 'resolution', 'proposalId' );
		if ( $allowed ) {
			$this->assertSame( array( 'status' => 'resolved' ), self::verdict( $answer, 'held-1' ) );
			$this->assertSame( array( 'held-1' => $resolution ), $stored );
			return;
		}

		$this->assertSame(
			array(
				'status' => 'refused',
				'reason' => 'not-allowed',
			),
			self::verdict( $answer, 'held-1' ),
			'The sender is told the decision was refused.'
		);
		$this->assertSame( array(), $stored, 'The held item stays open for someone who may decide.' );

		// A user who may decide can still close it.
		wp_set_current_user( $privileged );
		$later = self::commit( self::engine(), $room, 303, array( self::decision( 'held-1', 'dismissed' ) ) );
		$this->assertSame( array( 'status' => 'resolved' ), self::verdict( $later, 'held-1' ) );
	}

	/**
	 * An ordinary merge item (two edits that clash) is decided by anyone
	 * who can edit the post, whether or not they may publish unfiltered
	 * HTML.
	 */
	public function test_merge_item_is_decided_by_anyone_who_can_edit_the_post() {
		list( , $room, $block ) = $this->make_room();
		add_filter(
			'map_meta_cap',
			static function ( $caps, $cap ) {
				return 'unfiltered_html' === $cap ? array( 'do_not_allow' ) : $caps;
			},
			10,
			2
		);

		self::commit( self::engine(), $room, 101, array( self::align_edit( 'a-1', $block, 'wide' ) ) );
		$clash = self::commit( self::engine(), $room, 202, array( self::align_edit( 'b-1', $block, 'full' ) ) );
		$this->assertSame( 'escalated', self::verdict( $clash, 'b-1' )['status'] );

		wp_set_current_user( self::$other_editor_id );
		$answer = self::commit( self::engine(), $room, 303, array( self::decision( 'b-1', 'restored' ) ) );

		$this->assertSame( array( 'status' => 'resolved' ), self::verdict( $answer, 'b-1' ) );
		$this->assertCount( 1, self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED ) );
	}

	/*
	 * Everything that changes a room's rows holds the room's lock.
	 */

	/**
	 * Swaps in a lock that records when it is taken and released, and a
	 * storage that records its writes in the same list.
	 *
	 * @return Commit_Path_Recording_Storage The storage.
	 */
	private function recording_lock_and_storage(): Commit_Path_Recording_Storage {
		add_filter(
			'wp_sync_lock_backend',
			static function () {
				return new Commit_Path_Lock_Backend();
			}
		);
		WP_Sync_Room_Lock::reset_backend_for_testing();
		Commit_Path_Lock_Backend::$events = array();

		return new Commit_Path_Recording_Storage();
	}

	/**
	 * A read is the usual first caller of a room. The first document it
	 * makes is stored under the room's lock, so two readers cannot both
	 * store one and a reset cannot run in between. A read of a room that
	 * holds rows takes no lock.
	 */
	public function test_first_document_made_by_a_read_is_stored_under_the_lock() {
		list( , $room ) = $this->make_post();
		$storage        = $this->recording_lock_and_storage();
		$lock           = WP_Sync_Room_Lock::name_for_room( $room );

		$first = ( new WP_Intent_Log_Engine( $storage ) )->get_updates_since( $room, 101, 0, array() );

		$this->assertCount( 1, $first['updates'] );
		$this->assertSame( array( "acquire $lock", 'add_update', "release $lock" ), Commit_Path_Lock_Backend::$events );

		Commit_Path_Lock_Backend::$events = array();
		( new WP_Intent_Log_Engine( $storage ) )->get_updates_since( $room, 101, 0, array() );

		$this->assertSame( array(), Commit_Path_Lock_Backend::$events );
	}

	/**
	 * When the lock is not free, a read makes no first document. The tab
	 * gets no rows and asks again.
	 */
	public function test_read_makes_no_first_document_while_the_room_is_locked() {
		list( , $room )                 = $this->make_post();
		$storage                        = $this->recording_lock_and_storage();
		Commit_Path_Lock_Backend::$busy = true;

		$first = ( new WP_Intent_Log_Engine( $storage ) )->get_updates_since( $room, 101, 0, array() );

		$this->assertSame( array(), $first['updates'] );
		$this->assertNotContains( 'add_update', Commit_Path_Lock_Backend::$events );
	}

	/**
	 * A commit that makes the first document takes the lock once. The
	 * lock cannot be taken twice, also not by the process that holds it.
	 */
	public function test_commit_that_makes_the_first_document_takes_the_lock_once() {
		list( , $room, $block ) = $this->make_post();
		$storage                = $this->recording_lock_and_storage();
		$lock                   = WP_Sync_Room_Lock::name_for_room( $room );

		$answer = self::commit( new WP_Intent_Log_Engine( $storage ), $room, 101, array( self::text_edit( 'first-1', $block, 0, 'x', 0 ) ) );

		$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'first-1' ) );
		$this->assertSame( array( "acquire $lock", 'add_update', 'add_update', "release $lock" ), Commit_Path_Lock_Backend::$events );
	}

	/**
	 * The reset of a room nobody is in runs under the room's lock, so it
	 * never runs in the middle of a commit.
	 */
	public function test_reset_of_an_empty_room_runs_under_the_lock() {
		list( , $room ) = $this->make_room();
		$storage        = $this->recording_lock_and_storage();
		$lock           = WP_Sync_Room_Lock::name_for_room( $room );

		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->assertTrue( $presence->leave( $room, 'tab-a', 101 ) );

		$this->assertSame( array( "acquire $lock", 'reset_room', "release $lock" ), Commit_Path_Lock_Backend::$events );
		$this->assertSame( array(), ( new WP_Sync_Table_Storage() )->get_updates_after_cursor( $room, 0 ) );
	}

	/**
	 * A room whose lock is not free in time is in use, and is not reset.
	 */
	public function test_room_is_not_reset_while_it_is_locked() {
		list( , $room )                 = $this->make_room();
		$storage                        = $this->recording_lock_and_storage();
		Commit_Path_Lock_Backend::$busy = true;

		$presence = new Gutenberg_Sync_Engines_Advisory_Presence( $storage );
		$this->assertFalse( $presence->leave( $room, 'tab-a', 101 ) );

		$this->assertNotContains( 'reset_room', Commit_Path_Lock_Backend::$events );
		$this->assertCount( 1, ( new WP_Sync_Table_Storage() )->get_updates_after_cursor( $room, 0 ) );
	}
}

/**
 * A table storage that records where each read of a room's rows starts.
 */
class Commit_Path_Recording_Storage extends WP_Sync_Table_Storage {
	/**
	 * The position each read started after, in call order.
	 *
	 * @var int[]
	 */
	public $read_after = array();

	public function get_updates_after_cursor( string $room, int $cursor ): array {
		$this->read_after[] = $cursor;

		return parent::get_updates_after_cursor( $room, $cursor );
	}

	public function add_update( string $room, $update ): bool {
		Commit_Path_Lock_Backend::$events[] = 'add_update';

		return parent::add_update( $room, $update );
	}

	public function reset_room( string $room ): bool {
		Commit_Path_Lock_Backend::$events[] = 'reset_room';

		return parent::reset_room( $room );
	}
}

/**
 * A room lock that records when it is taken and released, and can be
 * told that every lock is held by someone else.
 */
class Commit_Path_Lock_Backend implements WP_Sync_Lock_Backend {
	/**
	 * What happened, in order. The recording storage adds its writes.
	 *
	 * @var string[]
	 */
	public static $events = array();

	/**
	 * Whether every lock is held by someone else.
	 *
	 * @var bool
	 */
	public static $busy = false;

	public function acquire( string $name, float $wait_seconds ) {
		if ( self::$busy ) {
			return new WP_Error( 'rest_sync_room_busy', 'Busy.', array( 'status' => 503 ) );
		}
		self::$events[] = "acquire $name";

		return 'token';
	}

	public function release( string $name, string $token ): void {
		self::$events[] = "release $name";
	}
}

/**
 * A table storage that can be told to refuse its next writes, to make a
 * commit fail midway.
 */
class Commit_Path_Refusing_Storage extends WP_Sync_Table_Storage {
	/**
	 * How many of the next writes to refuse.
	 *
	 * @var int
	 */
	public $refuse_writes = 0;

	public function add_update( string $room, $update ): bool {
		if ( $this->refuse_writes > 0 ) {
			--$this->refuse_writes;
			return false;
		}

		return parent::add_update( $room, $update );
	}
}
