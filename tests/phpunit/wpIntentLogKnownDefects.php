<?php
/**
 * Tests that prove server-side defects of the intent-log engine which
 * nobody has fixed yet (plan-rewrite-intent-log.md, Phase 0 step 3).
 *
 * Every test states the CORRECT behavior and wraps it in
 * assert_known_defect(). The test passes while the defect is there and
 * fails once it is fixed, so the fix removes the marker. To see the real
 * failure of each defect, run the file with RTC_KNOWN_DEFECTS_RAW=1:
 *
 *     npx @wordpress/env --config .wp-env.tests.json run cli \
 *         --env-cwd=wp-content/plugins/wp-real-time-collaboration \
 *         env RTC_KNOWN_DEFECTS_RAW=1 vendor/bin/phpunit \
 *         --filter Tests_Collaboration_WpIntentLogKnownDefects
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpIntentLogKnownDefects extends WP_UnitTestCase {
	use Known_Defect_Assertions;

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
			new WP_HTTP_Polling_Sync_Server( new WP_Sync_Table_Storage() )
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
		$server = new WP_HTTP_Polling_Sync_Server( new WP_Sync_Table_Storage() );

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
	 * Item 9: a commit planned against an old copy of the room.
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
	 * Defect: the daemon keeps one engine object for its whole life, and
	 * that object keeps the copy of the room its first read loaded. After
	 * another process writes, the daemon's next commit is combined against
	 * that old copy, so a clash with the other process's edit is missed
	 * and the edit is applied over it with nobody told.
	 *
	 * Plan item 9, first case. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer ) {
				$this->assertSame(
					array(
						'status' => 'escalated',
						'reason' => 'attr-conflict',
					),
					self::verdict( $answer, 'ws-1' ),
					'Two edits to one attribute from the same position are a conflict for a person to decide.'
				);
			}
		);
	}

	/**
	 * Defect: the same old copy also has an old length. An edit the
	 * WebSocket tab made after it received the other process's edit names
	 * a position past the end of the old copy, so it is refused as
	 * `invalid-payload` although it is a normal edit.
	 *
	 * Plan item 9, first case. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer ) {
				$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'ws-1' ) );
			}
		);
	}

	/**
	 * Defect: a commit that fails midway leaves the engine object holding
	 * the copy of the room it loaded. The next commit on the same object
	 * (the daemon's, for example, when the tab tries again) is combined
	 * against that copy and misses what another process wrote meanwhile.
	 *
	 * Plan item 9, second case. Fixed in Phase 4.
	 */
	public function test_commit_after_a_failed_commit_sees_what_another_process_wrote() {
		list( , $room, $block ) = $this->make_room();

		// One long-lived engine. Its first use of the room is a commit
		// whose write the storage refuses.
		$storage                = new Known_Defects_Refusing_Storage();
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer ) {
				$this->assertSame(
					array(
						'status' => 'escalated',
						'reason' => 'attr-conflict',
					),
					self::verdict( $answer, 'a-1' ),
					'Two edits to one attribute from the same position are a conflict for a person to decide.'
				);
			}
		);
	}

	/**
	 * Defect: a script save reads the room with no lock, which fills the
	 * engine's copy, then commits under the lock using that copy. An edit
	 * that another request stores between the two steps is not seen, so
	 * the script's change replaces it with nobody told.
	 *
	 * Plan item 9, third case. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $post_id ) {
				$statuses = array_column( (array) WP_Intent_Log_Base_Seq_Preflight::last_dispositions(), 'status' );
				$this->assertContains( 'escalated', $statuses, 'The clash is set aside for a person to decide.' );
				$this->assertStringContainsString(
					'"align":"wide"',
					get_post( $post_id )->post_content,
					'The saved post keeps the edit that was stored first.'
				);
			}
		);
	}

	/**
	 * Defect: when the last WebSocket tab leaves, the daemon resets the
	 * room but its engine object keeps the old copy. If that tab never
	 * typed, the next tab to open the post over WebSocket gets an empty
	 * answer: no first document is built, because the engine thinks the
	 * room is already loaded.
	 *
	 * Plan item 9, the inferred case. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $second ) {
				$this->assertNotEmpty( $second['updates'], 'The new tab gets the first document.' );
				$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $second['updates'][0]['type'] );
			}
		);
	}

	/**
	 * Defect: a second way to the same empty answer, found while writing
	 * the test above. The daemon's storage object remembers the position
	 * of the room's newest row and the engine trusts it. When another
	 * process resets the room (a closing tab's leave beacon goes to the
	 * web server, not to the daemon), the daemon still holds the old
	 * position, builds no first document, and answers the next tab with
	 * nothing. This happens even when the tab that left had typed, which
	 * emptied the engine's own copy.
	 *
	 * Plan item 9, the inferred case. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $second ) {
				$this->assertNotEmpty( $second['updates'], 'The new tab gets the first document.' );
				$this->assertSame( WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT, $second['updates'][0]['type'] );
			}
		);
	}

	/*
	 * Item 10: a snapshot throws away the recent history.
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
	 * Defect: when the engine loads a room it forgets every edit before
	 * the last snapshot. An edit that was already on its way, based on a
	 * position just before the snapshot, is refused as `stale-base`,
	 * although the rows needed to combine it are still stored.
	 *
	 * Plan item 10. Fixed in Phase 4.
	 */
	public function test_edit_in_flight_across_a_snapshot_is_combined() {
		list( , $room, $block ) = $this->make_room();
		$this->type_three_edits_past_a_snapshot( $room, $block );

		// A second tab typed at the end of the paragraph when it had seen
		// two of the three edits ("xxHello world", 13 characters).
		$answer = self::commit( self::engine(), $room, 202, array( self::text_edit( 'late-1', $block, 13, '!', 2 ) ) );

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer ) {
				$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'late-1' ) );
			}
		);
	}

	/**
	 * Defect: the list of edit ids already handled is forgotten at the
	 * same point. An edit that was applied just before a snapshot and is
	 * sent again (its answer was lost, say) gets `stale-base` instead of
	 * its first verdict, `applied`.
	 *
	 * Plan item 10. Fixed in Phase 4.
	 */
	public function test_applied_edit_sent_again_after_a_snapshot_gets_its_first_verdict() {
		list( , $room, $block ) = $this->make_room();
		$third                  = $this->type_three_edits_past_a_snapshot( $room, $block );

		$answer = self::commit( self::engine(), $room, 101, array( $third ) );

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer ) {
				$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'typed-2' ) );
			}
		);
		$this->assertSame(
			array( 'typed-0', 'typed-1', 'typed-2' ),
			self::stored_edit_ids( $room ),
			'A repeat never stores the edit twice.'
		);
	}

	/*
	 * "What is good and stays", the three gaps in one verdict per edit.
	 */

	/**
	 * Defect: a row whose edit id cannot be read is dropped without any
	 * answer, so the sender never learns it was refused.
	 *
	 * Plan, "What is good and stays", first gap. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer, $updates ) {
				$this->assertCount( count( $updates ), $answer['dispositions'], 'Every row sent gets a verdict.' );
			}
		);
	}

	/**
	 * Rows the engine cannot accept, each sent together with a good edit.
	 *
	 * @return array[] Data sets: the bad row.
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
			),
			'a bad `cancel` row'        => array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_CANCEL,
					'data' => wp_json_encode( array( 'cancelId' => 'c-1' ) ),
				),
			),
			'a row of a type not taken' => array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_SNAPSHOT,
					'data' => wp_json_encode( array( 'doc' => array( 'root' => array() ) ) ),
				),
			),
		);
	}

	/**
	 * Defect: one bad `resolved` or `cancel` row, or a row of a type a
	 * tab may not send, fails the whole request with a 400. A good edit
	 * sent in the same request is not stored.
	 *
	 * Plan, "What is good and stays", second gap. Fixed in Phase 4.
	 *
	 * @dataProvider data_bad_rows_beside_a_good_edit
	 *
	 * @param array $bad_row The row the engine cannot accept.
	 */
	public function test_bad_row_does_not_stop_a_good_edit_in_the_same_request( array $bad_row ) {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array( $bad_row, self::text_edit( 'good-1', $block, 0, 'x', 0 ) )
		);

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer, $room ) {
				$this->assertNotWPError( $answer, 'The request as a whole is answered.' );
				$this->assertSame( array( 'status' => 'applied' ), self::verdict( $answer, 'good-1' ) );
				$this->assertSame( array( 'good-1' ), self::stored_edit_ids( $room ) );
			}
		);
	}

	/**
	 * Defect: the `invalid-payload` verdict is not stored. The very same
	 * row, sent again later, can get a different answer. Here it is
	 * refused first, because its base is past the end of the history,
	 * and applied on the repeat, once the history has grown.
	 *
	 * Plan, "What is good and stays", third gap. Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $first, $again ) {
				$this->assertSame( self::verdict( $first, 'early-1' ), self::verdict( $again, 'early-1' ) );
			}
		);
	}

	/*
	 * "The server", inserted blocks are not checked fully.
	 */

	/**
	 * Defect: only the id, type and children of an inserted block are
	 * checked. Here the block's text is a number, and the edit is applied
	 * and stored as sent.
	 *
	 * Plan, "The server", "Check inserted blocks fully". Fixed in Phase 4.
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

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer, $room ) {
				$this->assertSame(
					array(
						'status' => 'voided',
						'reason' => 'invalid-payload',
					),
					self::verdict( $answer, 'bad-text' )
				);
				$this->assertSame( array(), self::stored_edit_ids( $room ) );
			}
		);
	}

	/**
	 * Defect: an inserted block whose list of formats is not a list makes
	 * the engine raise a TypeError while it combines the edit. Nothing in
	 * the daemon catches it.
	 *
	 * Plan, "The server", "Check inserted blocks fully". Fixed in Phase 4.
	 */
	public function test_inserted_block_with_formats_of_the_wrong_type_is_refused_without_an_error() {
		list( , $room, $block ) = $this->make_room();

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $room, $block ) {
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
			},
			TypeError::class
		);
	}

	/**
	 * Defect: an inserted block whose attributes are not a map is applied
	 * and stored. From then on the room cannot be turned into post
	 * content: materialize() raises an Error on every call, which breaks
	 * every later script save of that post.
	 *
	 * Plan, "The server", "Check inserted blocks fully". Fixed in Phase 4.
	 */
	public function test_inserted_block_with_attributes_of_the_wrong_type_does_not_break_the_room() {
		list( , $room, $block ) = $this->make_room();

		$answer = self::commit(
			self::engine(),
			$room,
			101,
			array( self::insert_edit( 'bad-attrs', $block, array( 'attrs' => 'not a map' ) ) )
		);
		$this->assertNotWPError( $answer );

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $room ) {
				$this->assertStringContainsString( 'Hello world', (string) self::engine()->materialize( $room ) );
			},
			Error::class
		);
	}

	/*
	 * "The server", a review decision is not checked.
	 */

	/**
	 * Defect: any user who can edit the post can close any review item.
	 * Here an edit is held because its author may not publish its markup
	 * (no `unfiltered_html`). Another user who also lacks that right
	 * sends "approve" (`restored`), and the server closes the item.
	 *
	 * The rule comes from docs/conflict-review.md ("A person allowed to
	 * publish unfiltered HTML can open it, then approve, edit, or remove
	 * the block") and the editor's own text ("Only someone allowed to
	 * publish unfiltered HTML can approve this.").
	 *
	 * Plan, "The server", "Check a review decision on the server". Fixed
	 * in Phase 4.
	 */
	public function test_held_markup_is_not_approved_by_a_user_who_may_not_publish_it() {
		list( , $room, $block ) = $this->make_room();

		// Nobody in this test may publish unfiltered HTML.
		add_filter(
			'map_meta_cap',
			static function ( $caps, $cap ) {
				if ( 'unfiltered_html' === $cap ) {
					return array( 'do_not_allow' );
				}

				return $caps;
			},
			10,
			2
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

		// Another editor, who may not publish it either, approves it.
		wp_set_current_user( self::$other_editor_id );
		$this->assertTrue( current_user_can( 'edit_post', (int) substr( $room, strlen( 'postType/post:' ) ) ) );
		$this->assertFalse( current_user_can( 'unfiltered_html' ) );
		$answer = self::commit(
			self::engine(),
			$room,
			202,
			array(
				array(
					'type' => WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED,
					'data' => wp_json_encode(
						array(
							'proposalId' => 'held-1',
							'resolution' => 'restored',
						)
					),
				),
			)
		);

		$this->assert_known_defect(
			'Phase 4',
			function () use ( $answer, $room ) {
				$this->assertSame(
					array(),
					self::stored_rows( $room, WP_Intent_Log_Engine::UPDATE_TYPE_RESOLVED ),
					'The held item stays open for someone who may decide.'
				);
				$verdict = self::verdict( $answer, 'held-1' );
				$this->assertNotSame( 'resolved', $verdict['status'] ?? null, 'The sender is told the decision was refused.' );
			}
		);
	}
}

/**
 * A table storage that can be told to refuse its next writes, to make a
 * commit fail midway.
 */
class Known_Defects_Refusing_Storage extends WP_Sync_Table_Storage {
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
