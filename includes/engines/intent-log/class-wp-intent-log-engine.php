<?php
/**
 * WP_Intent_Log_Engine class
 *
 * @package gutenberg
 */

if ( ! class_exists( 'WP_Intent_Log_Engine' ) ) {

	/**
	 * The intent-log sync engine: a server-sequenced log of typed intents
	 * with server-side rebase, per-intent dispositions, and an escalation
	 * lane — the server half of the engine whose client core lives in
	 * `src/engines/intent-log/` and is specified in
	 * `src/engines/intent-log/SPEC.md`.
	 *
	 * Wire protocol over the transport's typed updates:
	 *
	 * - `snapshot` (server → client): JSON `{ doc }` — the genesis document,
	 *   stored as the room's first row when the room initializes from post
	 *   content. Clients bootstrap from it and treat its position as seq 0.
	 * - `intent` (client → server → clients): JSON intent envelope. Clients
	 *   send authored intents; the server plans them (WP_Intent_Log_Planner),
	 *   stores ACCEPTED intents with their transformed payloads, and relays
	 *   those rows to every client (including the author, who needs the
	 *   authoritative transformed form). The engine log = intent rows in
	 *   storage order; an intent's `baseSeq` counts intent rows. Each
	 *   stored intent row carries `seq`, the room's position after it
	 *   (the first edit of a room has 1), stamped by the server. A tab
	 *   checks it and starts the room over when a number is missing.
	 * - `parked` (server → clients): JSON `{ intent, actorId, reason }` —
	 *   an escalated intent parked for review (the proposal lane).
	 * - `voided` (server → clients): JSON `{ intentId, reason }` — a voided
	 *   disposition marker, persisted so redelivered intents settle
	 *   identically (exactly-once semantics over at-least-once transports).
	 *
	 * Ingest responds with a per-intent `dispositions` array through the
	 * transport (applied / escalated / voided), which is the client's ack.
	 *
	 * Attribution: `actorId` is stamped server-side as
	 * `u{user_id}c{client_id}` — the user half is authenticated, the client
	 * half is bound by the transport's client-id ownership check, and the
	 * per-tab client id preserves the planner's one-session-per-actor
	 * authoring model. Client-sent actorId values are ignored.
	 *
	 * Compaction: a checkpoint snapshot row is appended once
	 * `wp_sync_intent_log_checkpoint_interval` intent rows (default 500)
	 * accumulate since the previous checkpoint; history below the previous
	 * checkpoint is then trimmed and recorded as the room floor. Clients
	 * whose cursor falls below the floor bootstrap again from the retained
	 * checkpoint snapshot, and unresolved proposals below the trim are
	 * re-appended so review work survives (see maybe_checkpoint()). The
	 * rows between the previous checkpoint and the newest one stay stored,
	 * and load_room() keeps them in the history, so an edit made just
	 * before a checkpoint is still combined after it.
	 *
	 * Genesis/materialization map a block's inner HTML onto the engine's
	 * `content` field plus the `_wrapper` internal attr (the Phase 2a
	 * model); since client-authored save markup landed, the client
	 * bridge keeps BOTH save-accurate (wrapper refresh + save-derived
	 * content for non-rich-text blocks), so sourced-attribute edits
	 * survive materialization.
	 *
	 * @since 7.2.0
	 * @access private
	 */
	class WP_Intent_Log_Engine implements WP_Sync_Engine {
		/**
		 * Engine slug.
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const SLUG = 'intent-log';

		/**
		 * Engine protocol version.
		 *
		 * @since 7.2.0
		 * @var int
		 */
		const PROTOCOL_VERSION = 3;

		/**
		 * Update type: client-authored intent (stored transformed; when the
		 * transform moved it, `authoredPayload` keeps the payload as sent).
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const UPDATE_TYPE_INTENT = 'intent';

		/**
		 * Update type: room genesis snapshot.
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const UPDATE_TYPE_SNAPSHOT = 'snapshot';

		/**
		 * Update type: an escalated intent parked for review (the proposal lane).
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const UPDATE_TYPE_PARKED = 'parked';

		/**
		 * Update type: persisted voided-disposition marker.
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const UPDATE_TYPE_VOIDED = 'voided';

		/**
		 * Update type: a proposal's terminal state (client-sendable).
		 * `{ proposalId, resolution: restored|dismissed }`, server-stamped
		 * with `resolvedBy` and `time`. Idempotent by proposalId.
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const UPDATE_TYPE_RESOLVED = 'resolved';

		/**
		 * Client-sent only, never stored: cancels intents that are still
		 * queued (the pre-settle undo lane). All-or-nothing per cancel
		 * row: if
		 * ANY target already settled, nothing cancels and the cancel acks
		 * `cancel-too-late` (the client resurrects the unit from the
		 * accepted rows). Confirmed cancellations settle each target as a
		 * `voided`/`canceled` marker row, so redeliveries stay idempotent.
		 */
		const UPDATE_TYPE_CANCEL = 'cancel';

		/**
		 * Escalation reason for intents whose payload carries markup the
		 * authoring user may not publish (per `wp_kses_post`): the intent is
		 * parked for review instead of applied, and only a user with
		 * `unfiltered_html` can meaningfully restore it (a restore re-authors
		 * the content as ordinary intents under the RESTORER's capability, so
		 * an unprivileged restore simply re-escalates).
		 *
		 * @since 7.2.0
		 * @var string
		 */
		const ESCALATION_REQUIRES_APPROVAL = 'requires-approval';

		/**
		 * Storage backend.
		 *
		 * @since 7.2.0
		 * @var WP_RTC_Storage
		 */
		private WP_RTC_Storage $storage;

		/**
		 * Loaded room state, keyed by room. Each entry remembers the id of
		 * the room's newest stored row at the time it was loaded (its
		 * `cursor`), and load_room() uses the entry only while that row is
		 * still the newest. Row ids only grow and are never used twice, so
		 * a write or a reset by another process always shows.
		 *
		 * @since 7.2.0
		 * @var array<string, array>
		 */
		private array $room_state = array();

		/**
		 * Per-request debug info stash, keyed by room (ingest fills it,
		 * get_updates_since attaches it as the `_debug` envelope when the
		 * request opted in).
		 *
		 * @since 7.2.0
		 * @var array<string, array>
		 */
		private array $debug_stash = array();

		/**
		 * The newest position of a room after this request's commit, keyed
		 * by room. The read half of the same request sends it as `seq`.
		 *
		 * @since n.e.x.t
		 * @var array<string, int>
		 */
		private array $head_seq_stash = array();

		/**
		 * Constructor.
		 *
		 * @since 7.2.0
		 *
		 * @param WP_RTC_Storage $storage Storage backend.
		 */
		public function __construct( WP_RTC_Storage $storage ) {
			$this->storage = $storage;
		}

		/**
		 * Returns the engine slug.
		 *
		 * @since 7.2.0
		 *
		 * @return string Engine slug.
		 */
		public function get_slug(): string {
			return self::SLUG;
		}

		/**
		 * Returns the engine protocol version.
		 *
		 * @since 7.2.0
		 *
		 * @return int Protocol version.
		 */
		public function get_protocol_version(): int {
			return self::PROTOCOL_VERSION;
		}

		/**
		 * Returns the update types this engine accepts on the route. Clients
		 * may only SEND `intent`; the rest are server-emitted (enforced in
		 * handle_updates).
		 *
		 * @since 7.2.0
		 *
		 * @return string[] Accepted update types.
		 */
		public function get_update_types(): array {
			return array(
				self::UPDATE_TYPE_INTENT,
				self::UPDATE_TYPE_SNAPSHOT,
				self::UPDATE_TYPE_PARKED,
				self::UPDATE_TYPE_VOIDED,
				self::UPDATE_TYPE_RESOLVED,
				self::UPDATE_TYPE_CANCEL,
			);
		}

		/**
		 * The server-stamped actor id for a request.
		 *
		 * @since 7.2.0
		 *
		 * @param int $client_id Transport client id.
		 * @return string Actor id.
		 */
		public static function actor_id( int $client_id ): string {
			return 'u' . get_current_user_id() . 'c' . $client_id;
		}

		/**
		 * Tokens for locks this instance currently holds, by room.
		 *
		 * @since 0.5.0
		 *
		 * @var array<string, string>
		 */
		private $room_lock_tokens = array();

		/**
		 * Acquires the per-room ingest lock (Core-style options-row lock;
		 * see WP_Sync_Room_Lock for why not GET_LOCK).
		 *
		 * @since 7.2.0
		 *
		 * @param string $room Room identifier.
		 * @return true|WP_Error True when held, retryable error otherwise.
		 */
		private function acquire_room_lock( string $room ) {
			// 5s budget; a plan is milliseconds, so contention clears fast.
			$token = WP_Sync_Room_Lock::acquire( $this->room_lock_name( $room ), 5.0 );
			if ( is_wp_error( $token ) ) {
				// Budget exhausted: the client retries on its normal poll
				// cadence.
				return $token;
			}
			$this->room_lock_tokens[ $room ] = $token;

			return true;
		}

		/**
		 * Releases the per-room ingest lock.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room Room identifier.
		 */
		private function release_room_lock( string $room ): void {
			WP_Sync_Room_Lock::release(
				$this->room_lock_name( $room ),
				(string) ( $this->room_lock_tokens[ $room ] ?? '' )
			);
			unset( $this->room_lock_tokens[ $room ] );
		}

		/**
		 * The lock option name for a room, table-prefixed for isolation and
		 * hashed to a bounded length.
		 *
		 * @since 7.2.0
		 *
		 * @global wpdb $wpdb WordPress database abstraction object.
		 *
		 * @param string $room Room identifier.
		 * @return string Lock name.
		 */
		private function room_lock_name( string $room ): string {
			return WP_Sync_Room_Lock::name_for_room( $room );
		}

		/**
		 * Ingests a batch of intent updates from one client.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Client transport cursor (unused; intents
		 *                          carry their own baseSeq).
		 * @param array  $updates   Typed updates.
		 * @param array  $context   Transport context.
		 * @return array|WP_Error array( 'dispositions' => array ) or error.
		 */
		public function handle_updates( string $room, int $client_id, int $cursor, array $updates, array $context ) {
			if ( array() === $updates ) {
				return array( 'dispositions' => null );
			}

			/*
			 * Serialize ingest per room: the whole design rests on a single
			 * server-assigned total order, and load→plan→commit is not
			 * atomic. Two concurrent pollers planning against the same log
			 * length would commit transformed payloads with conflicting
			 * bases and diverge every replica. The lock is per-room, so
			 * rooms never contend with each other.
			 */
			$lock_started = microtime( true );
			$lock         = $this->acquire_room_lock( $room );
			$lock_wait_ms = round( ( microtime( true ) - $lock_started ) * 1000, 1 );
			if ( is_wp_error( $lock ) ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: ingest lock timeout for {$room} after {$lock_wait_ms}ms" );
				return $lock;
			}
			try {
				return $this->handle_updates_in_one_batch( $room, $client_id, $updates, $context, $lock_wait_ms );
			} finally {
				$this->release_room_lock( $room );
			}
		}

		/**
		 * Runs the commit so that the rows of one request are stored
		 * together or not at all, where the storage can do that. A commit
		 * is many writes: one per edit, plus markers, review items and a
		 * snapshot. A failure in the middle must not leave half of them
		 * stored, because the sender tries the whole request again.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room         Room identifier.
		 * @param int    $client_id    Client identifier.
		 * @param array  $updates      Typed updates.
		 * @param array  $context      Transport context.
		 * @param float  $lock_wait_ms Time spent acquiring the ingest lock.
		 * @return array|WP_Error array( 'dispositions' => array ) or error.
		 * @throws Throwable Whatever the commit raises, after the batch
		 *                   was thrown away.
		 */
		private function handle_updates_in_one_batch( string $room, int $client_id, array $updates, array $context, float $lock_wait_ms ) {
			if ( ! $this->storage_has_batches( $room ) || ! $this->storage->begin_batch() ) {
				return $this->handle_updates_locked( $room, $client_id, $updates, $context, $lock_wait_ms );
			}

			try {
				$result = $this->handle_updates_locked( $room, $client_id, $updates, $context, $lock_wait_ms );
			} catch ( Throwable $error ) {
				$this->storage->rollback_batch();
				unset( $this->room_state[ $room ] );
				throw $error;
			}

			if ( is_wp_error( $result ) ) {
				$this->storage->rollback_batch();
				unset( $this->room_state[ $room ] );
				return $result;
			}
			if ( ! $this->storage->commit_batch() ) {
				unset( $this->room_state[ $room ] );
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store sync update.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}

			return $result;
		}

		/**
		 * Whether a commit to this room runs as one batch of writes.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room Room identifier.
		 * @return bool Whether the storage offers batches and they are on.
		 */
		private function storage_has_batches( string $room ): bool {
			if (
				! method_exists( $this->storage, 'begin_batch' ) ||
				! method_exists( $this->storage, 'commit_batch' ) ||
				! method_exists( $this->storage, 'rollback_batch' )
			) {
				return false;
			}

			/**
			 * Filters whether the rows of one request are stored in one
			 * database transaction. Return false where the connection
			 * already runs inside a transaction of its own, because
			 * starting one ends the other. The plugin's own PHPUnit
			 * suite does that: WordPress runs each test in a transaction.
			 *
			 * @since n.e.x.t
			 *
			 * @param bool   $enabled Default true.
			 * @param string $room    Room identifier.
			 */
			return (bool) apply_filters( 'wp_rtc_commit_in_transaction', true, $room );
		}

		/**
		 * The body of handle_updates(), run under the per-room ingest lock.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room         Room identifier.
		 * @param int    $client_id    Client identifier.
		 * @param array  $updates      Typed updates.
		 * @param array  $context      Transport context (debug opt-in).
		 * @param float  $lock_wait_ms Time spent acquiring the ingest lock.
		 * @return array|WP_Error array( 'dispositions' => array ) or error.
		 */
		private function handle_updates_locked( string $room, int $client_id, array $updates, array $context = array(), float $lock_wait_ms = 0 ) {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return $state;
			}

			$actor_id = self::actor_id( $client_id );
			$base_seq = (int) ( $state['base_seq'] ?? 0 );
			$head_seq = $base_seq + count( $state['log'] );

			// 1. Read the rows. A bad row is refused here, by itself.
			$decoded = self::decode_updates( $updates, $actor_id, $head_seq );
			if ( $decoded['refused'] > 0 ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: {$decoded['refused']} malformed row(s) refused in {$room}" );
			}
			$stored = $this->store_refusals( $room, $client_id, $decoded['refusals'], $state );
			if ( is_wp_error( $stored ) ) {
				return $stored;
			}

			// 2. Cancellations of edits that have no verdict yet.
			$cancel_dispositions = $this->apply_cancels( $room, $client_id, $decoded['cancels'], $state );
			if ( is_wp_error( $cancel_dispositions ) ) {
				return $cancel_dispositions;
			}

			// 3. Drop repeats and edits based below the stored history.
			$stale = array();
			$units = self::drop_repeats( $decoded['intents'], $state, $base_seq, $stale );

			// 4. Markup the author may not publish is held for approval.
			list( $units, $requires_approval ) = self::split_by_markup_policy( $units );
			$doc_at                            = self::document_reader( $state );
			$stored                            = $this->park_for_approval( $room, $client_id, $requires_approval, $head_seq, $doc_at, $state );
			if ( is_wp_error( $stored ) ) {
				return $stored;
			}

			// 5. Combine the edits with the history. The batch's frame
			// continues from this actor's earlier set-aside intents, so a
			// typist whose editor still shows a set-aside letter parks the
			// keystrokes that follow it beside it (rule 6 across requests)
			// instead of landing them misplaced.
			$plan = WP_Intent_Log_Planner::plan_batch(
				$units,
				$state['log'],
				$doc_at,
				$base_seq,
				WP_Intent_Log_Planner::seed_frame_state( $state['parked'][ $actor_id ] ?? array() )
			);

			// 6. Store the result.
			$stored = $this->store_plan( $room, $client_id, $plan, $head_seq, $doc_at, $state );
			if ( is_wp_error( $stored ) ) {
				return $stored;
			}

			// 7. Growth bound: append a compaction checkpoint (and trim
			// behind the previous one) once the retained window is large
			// enough.
			$accepted_count = 0;
			foreach ( $plan['rows'] as $row ) {
				if ( null !== $row['accepted'] ) {
					++$accepted_count;
				}
			}
			$checkpointed = $this->maybe_checkpoint(
				$room,
				$client_id,
				$head_seq - $state['snapshot_seq'] + $accepted_count,
				$head_seq + $accepted_count,
				$plan['headDoc']
			);
			$this->note_commit( $room, $context, $lock_wait_ms, $state, $plan, $stale, $requires_approval, $head_seq + $accepted_count, $checkpointed );
			$this->head_seq_stash[ $room ] = $head_seq + $accepted_count;

			// 8. Review decisions, after the edits.
			$refused_decisions = $this->apply_decisions( $room, $client_id, $actor_id, $decoded['resolutions'], $state );
			if ( is_wp_error( $refused_decisions ) ) {
				return $refused_decisions;
			}

			unset( $this->room_state[ $room ] ); // Rows changed.

			// 9. One answer per row, in the order the rows were sent.
			return array(
				'dispositions' => self::build_answers( $decoded['answers'], $state, $stale, $cancel_dispositions, $refused_decisions ),
			);
		}

		/**
		 * Stores the refusals of malformed edits.
		 *
		 * The refusal of a malformed edit is stored like any other
		 * verdict, so the same row sent again gets the same answer.
		 * Without the marker the answer could change: an edit refused
		 * because its base was past the end of the history would be
		 * applied once the history had grown.
		 *
		 * An edit refused as `stale-base` (further down) needs no
		 * marker. The start of the stored history only moves forward,
		 * so a repeat is refused again. A marker would also reach the
		 * author's tab before the answer does, and settle the edit
		 * there before the tab has recovered its text.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param array  $refusals  Edit id => refusal, from decode_updates().
		 * @param array  $state     Room state. Its verdicts are updated.
		 * @return true|WP_Error True, or a storage error.
		 */
		private function store_refusals( string $room, int $client_id, array $refusals, array &$state ) {
			foreach ( $refusals as $intent_id => $verdict ) {
				if ( isset( $state['settled'][ $intent_id ] ) ) {
					continue;
				}
				$stored = $this->add_row(
					$room,
					$client_id,
					self::UPDATE_TYPE_VOIDED,
					array(
						'intentId' => $intent_id,
						'reason'   => $verdict['reason'],
					)
				);
				if ( ! $stored ) {
					return new WP_Error(
						'rest_sync_storage_error',
						__( 'Failed to store sync update.', 'gutenberg' ),
						array( 'status' => 500 )
					);
				}
				$state['settled'][ $intent_id ] = $verdict;
			}

			return true;
		}

		/**
		 * Applies the cancellations of one request.
		 *
		 * Intent cancellations (the pre-settle undo lane).
		 * All-or-nothing per cancel row: if ANY target already settled
		 * (other than as canceled), nothing cancels and the cancel acks
		 * `cancel-too-late` — the client resurrects the unit from the
		 * accepted rows. Confirmed targets settle as voided/`canceled`
		 * marker rows: idempotent against redelivery, dead against a
		 * late-arriving copy of the intent, and same-batch copies drop
		 * in the settled filter below.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param array  $cancels   Cancel rows, from decode_updates().
		 * @param array  $state     Room state. Its verdicts are updated.
		 * @return array|WP_Error Cancel id => answer, or a storage error.
		 */
		private function apply_cancels( string $room, int $client_id, array $cancels, array &$state ) {
			$cancel_dispositions = array();
			foreach ( $cancels as $cancel ) {
				$targets  = array_values( array_filter( $cancel['intentIds'], 'is_string' ) );
				$too_late = false;
				foreach ( $targets as $target_id ) {
					$prior = $state['settled'][ $target_id ] ?? null;
					if ( null !== $prior && 'canceled' !== ( $prior['reason'] ?? null ) ) {
						$too_late = true;
						break;
					}
				}
				if ( $too_late ) {
					$cancel_dispositions[ $cancel['cancelId'] ] = array(
						'status' => 'voided',
						'reason' => 'cancel-too-late',
					);
					continue;
				}
				foreach ( $targets as $target_id ) {
					if ( isset( $state['settled'][ $target_id ] ) ) {
						continue; // Redelivered cancel: already confirmed.
					}
					$stored = $this->add_row(
						$room,
						$client_id,
						self::UPDATE_TYPE_VOIDED,
						array(
							'intentId' => $target_id,
							'reason'   => 'canceled',
						)
					);
					if ( ! $stored ) {
						return new WP_Error(
							'rest_sync_storage_error',
							__( 'Failed to store sync update.', 'gutenberg' ),
							array( 'status' => 500 )
						);
					}
					$state['settled'][ $target_id ] = array(
						'status' => 'voided',
						'reason' => 'canceled',
					);
				}
				$cancel_dispositions[ $cancel['cancelId'] ] = array( 'status' => 'applied' );
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', 'wp-sync: canceled ' . count( $targets ) . " queued intent(s) in {$room}" );
			}

			return $cancel_dispositions;
		}

		/**
		 * Groups the edits of one request into units and drops the ones
		 * that need no combining.
		 *
		 * Group first, then drop already-settled intents within units, so
		 * a redelivered prefix cannot fuse two distinct units (mirrors the
		 * JS engine's serverIngestBatch). The in-batch set extends the
		 * idempotency to duplicates WITHIN one request: the settled map
		 * is only populated after planning. Intents authored BELOW the
		 * retention horizon (baseSeq < base_seq — the priors they need
		 * were compacted away, so a one-sided transform is impossible)
		 * settle immediately as stale voids without planning; the client
		 * re-derives the work from its editor tree after its reset.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $intents  Usable edits, from decode_updates().
		 * @param array $state    Room state.
		 * @param int   $base_seq Where the stored history starts.
		 * @param array $stale    Filled with edit id => `stale-base` refusal.
		 * @return array[] The units left to combine.
		 */
		private static function drop_repeats( array $intents, array $state, int $base_seq, array &$stale ): array {
			$seen_in_batch     = array();
						$units = array();
			foreach ( WP_Intent_Log_Planner::group_units( $intents ) as $unit ) {
				$fresh = array_values(
					array_filter(
						$unit,
						static function ( $intent ) use ( $state, $base_seq, &$seen_in_batch, &$stale ) {
							$intent_id = $intent['intentId'];
							if ( isset( $state['settled'][ $intent_id ] ) || isset( $seen_in_batch[ $intent_id ] ) ) {
								return false;
							}
							$seen_in_batch[ $intent_id ] = true;
							if ( $intent['baseSeq'] < $base_seq ) {
								$stale[ $intent_id ] = array(
									'status' => 'voided',
									'reason' => 'stale-base',
								);
								return false;
							}
							return true;
						}
					)
				);
				if ( count( $fresh ) > 0 ) {
					$units[] = $fresh;
				}
			}

			return $units;
		}

		/**
		 * Splits the units into those to combine and those to hold for
		 * approval.
		 *
		 * Capability enforcement (the kses lane): when the authoring user
		 * lacks `unfiltered_html`, an intent whose payload carries
		 * protected markup never reaches the planner — its WHOLE unit (a
		 * batch of edits made together) parks as a `requires-approval`
		 * proposal instead. This closes the laundering hole where a
		 * filtered user's markup would otherwise materialize into every
		 * collaborator's editor and then persist under a privileged
		 * saver's capability. Restoring the proposal re-authors the
		 * content as ordinary intents under the RESTORER's capability, so
		 * approval semantics need no separate machinery.
		 *
		 * @since n.e.x.t
		 *
		 * @param array[] $units Units of edits.
		 * @return array{array[], array[]} Units to combine, units to hold.
		 */
		private static function split_by_markup_policy( array $units ): array {
			$requires_approval = array();
			if ( ! current_user_can( 'unfiltered_html' ) ) {
				$kept = array();
				foreach ( $units as $unit ) {
					$protected = false;
					foreach ( $unit as $intent ) {
						if ( self::intent_requires_unfiltered_html( $intent ) ) {
							$protected = true;
							break;
						}
					}
					if ( $protected ) {
						$requires_approval[] = $unit;
					} else {
						$kept[] = $unit;
					}
				}
				$units = $kept;
			}

			return array( $units, $requires_approval );
		}

		/**
		 * A function that gives the document at a position of a loaded
		 * room, replayed from the nearest document it already has.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $state Room state.
		 * @return callable Position => document.
		 */
		private static function document_reader( array $state ): callable {
			$base_seq  = (int) $state['base_seq'];
			$log       = $state['log'];
			$doc_cache = array(
				$base_seq              => $state['genesis'],
				$state['snapshot_seq'] => $state['snapshot_doc'],
			);
			return static function ( int $seq ) use ( $log, $base_seq, &$doc_cache ): array {
				if ( isset( $doc_cache[ $seq ] ) ) {
					return $doc_cache[ $seq ];
				}
				$nearest = $base_seq;
				foreach ( array_keys( $doc_cache ) as $key ) {
					if ( $key <= $seq && $key > $nearest ) {
						$nearest = $key;
					}
				}
				$doc               = WP_Intent_Log_Document::replay(
					$doc_cache[ $nearest ],
					array_slice( $log, $nearest - $base_seq, $seq - $nearest )
				);
				$doc_cache[ $seq ] = $doc;
				return $doc;
			};
		}

		/**
		 * Stores the units held for approval as review items, in the same
		 * row shape as the planner's set-aside edits, so replay, retention
		 * and review decisions treat them alike.
		 *
		 * @since n.e.x.t
		 *
		 * @param string   $room              Room identifier.
		 * @param int      $client_id         Client identifier.
		 * @param array[]  $requires_approval Units to hold.
		 * @param int      $head_seq          The newest position before this commit.
		 * @param callable $doc_at            Position => document.
		 * @param array    $state             Room state. Updated.
		 * @return true|WP_Error True, or a storage error.
		 */
		private function park_for_approval( string $room, int $client_id, array $requires_approval, int $head_seq, callable $doc_at, array &$state ) {
			foreach ( $requires_approval as $unit ) {
				foreach ( $unit as $intent ) {
					$intent_id = $intent['intentId'];
					$stored    = $this->add_row(
						$room,
						$client_id,
						self::UPDATE_TYPE_PARKED,
						array(
							'intent'  => $intent,
							'actorId' => $intent['actorId'],
							'reason'  => self::ESCALATION_REQUIRES_APPROVAL,
							'at'      => $head_seq,
							'time'    => time(),
							'context' => array(
								'excerpt' => self::proposal_excerpt( $doc_at( $head_seq ), $intent ),
							),
						)
					);
					if ( ! $stored ) {
						return new WP_Error(
							'rest_sync_storage_error',
							__( 'Failed to store sync update.', 'gutenberg' ),
							array( 'status' => 500 )
						);
					}
					$state['proposals_open'][ $intent_id ] = array(
						'reason'  => self::ESCALATION_REQUIRES_APPROVAL,
						'actorId' => $intent['actorId'],
					);
					$state['settled'][ $intent_id ]        = array(
						'status' => 'escalated',
						'reason' => self::ESCALATION_REQUIRES_APPROVAL,
					);
				}
			}

			return true;
		}

		/**
		 * Stores what the planner decided: accepted edits, set-aside edits
		 * and markers for the ones thrown away.
		 *
		 * @since n.e.x.t
		 *
		 * @param string   $room      Room identifier.
		 * @param int      $client_id Client identifier.
		 * @param array    $plan      The planner's result.
		 * @param int      $head_seq  The newest position before this commit.
		 * @param callable $doc_at    Position => document.
		 * @param array    $state     Room state. Updated.
		 * @return true|WP_Error True, or a storage error.
		 */
		private function store_plan( string $room, int $client_id, array $plan, int $head_seq, callable $doc_at, array &$state ) {
			$seq = $head_seq;
			foreach ( $plan['rows'] as $row ) {
				$intent_id = $row['intent']['intentId'];
				if ( null !== $row['accepted'] ) {
					$accepted = $row['accepted'];

					// The room's position after this edit, stored with it.
					// Nobody has to count rows to know where an edit sits.
					$accepted['seq'] = ++$seq;

					/*
					 * The row stores the transformed form (its coordinates
					 * hold at its log position). When the transform moved
					 * it, the row also keeps the payload as the author sent
					 * it: a set-aside edit by the same author is expressed
					 * against the author's own view, which held this one at
					 * its authored place, and the review lane rebuilds that
					 * view from the log (see intent-log-conflicts.ts).
					 */
					if ( $accepted['payload'] !== $row['intent']['payload'] || isset( $accepted['textSlices'] ) ) {
						$accepted['authoredPayload'] = $row['intent']['payload'];
					}
					$stored = $this->add_row( $room, $client_id, self::UPDATE_TYPE_INTENT, $accepted );
				} elseif ( null !== $row['proposal'] ) {
					/*
					 * Review context, captured while the document is at hand:
					 * offsets go stale the moment the log moves on, so the
					 * row carries a content excerpt of the target field for
					 * content-centric rendering (see PROPOSAL-REVIEW.md).
					 */
					$proposal            = $row['proposal'];
					$proposal['at']      = $head_seq;
					$proposal['time']    = time();
					$proposal['context'] = array(
						'excerpt' => self::proposal_excerpt( $doc_at( $head_seq ), $row['intent'] ),
					);
					$stored              = $this->add_row( $room, $client_id, self::UPDATE_TYPE_PARKED, $proposal );
					// Same-request resolutions can target it.
					$state['proposals_open'][ $intent_id ] = array(
						'reason'  => $proposal['reason'],
						'actorId' => $proposal['actorId'],
					);
				} else {
					$stored = true;
				}
				// Apply-time voids live in the log AND get a marker; pure
				// rebase voids get only the marker.
				if ( 'voided' === $row['disposition']['status'] ) {
					$stored = $stored && $this->add_row(
						$room,
						$client_id,
						self::UPDATE_TYPE_VOIDED,
						array(
							'intentId' => $intent_id,
							'reason'   => $row['disposition']['reason'],
						)
					);
				}
				if ( ! $stored ) {
					return new WP_Error(
						'rest_sync_storage_error',
						__( 'Failed to store sync update.', 'gutenberg' ),
						array( 'status' => 500 )
					);
				}
				$state['settled'][ $intent_id ] = $row['disposition'];
			}

			return true;
		}

		/**
		 * Reports what a commit did to Query Monitor, and keeps the
		 * numbers for the debug section of the answer when the tab asked
		 * for it (the read half of the same request attaches them).
		 *
		 * @since n.e.x.t
		 *
		 * @param string  $room              Room identifier.
		 * @param array   $context           Transport context (debug opt-in).
		 * @param float   $lock_wait_ms      Time spent acquiring the lock.
		 * @param array   $state             Room state.
		 * @param array   $plan              The planner's result.
		 * @param array   $stale             Edits refused as `stale-base`.
		 * @param array[] $requires_approval Units held for approval.
		 * @param int     $new_head_seq      The newest position after this commit.
		 * @param bool    $checkpointed      Whether a checkpoint was written.
		 */
		private function note_commit( string $room, array $context, float $lock_wait_ms, array $state, array $plan, array $stale, array $requires_approval, int $new_head_seq, bool $checkpointed ): void {
			$plan_counts = array(
				'applied'   => 0,
				'escalated' => 0,
				'voided'    => 0,
			);
			foreach ( $plan['rows'] as $row ) {
				$status = $row['disposition']['status'];
				if ( isset( $plan_counts[ $status ] ) ) {
					++$plan_counts[ $status ];
				}
			}
			$plan_counts['stale']    = count( $stale );
			$plan_counts['approval'] = array_sum( array_map( 'count', $requires_approval ) );
			if ( $plan_counts['escalated'] > 0 ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: {$plan_counts['escalated']} intent(s) escalated for review in {$room}" );
			}
			if ( $plan_counts['approval'] > 0 ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: {$plan_counts['approval']} intent(s) parked for approval in {$room} (author lacks unfiltered_html)" );
			}
			if ( $plan_counts['stale'] > 0 ) {
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: {$plan_counts['stale']} stale-base intent(s) voided in {$room} (client below retention horizon)" );
			}
			if ( ! empty( $context['debug'] ) ) {
				$this->debug_stash[ $room ] = array(
					'lock_wait_ms' => $lock_wait_ms,
					'window_rows'  => count( $state['log'] ),
					'head_seq'     => $new_head_seq,
					'plan'         => $plan_counts,
					'checkpoint'   => $checkpointed,
				);
			}
		}

		/**
		 * Applies the review decisions of one request.
		 *
		 * Resolutions, after intents: close open proposals. Idempotent by
		 * proposalId — a redelivered, concurrent, or trimmed-and-resolved
		 * (unknown) id acks as resolved without a new row; only a
		 * currently-open proposal appends one, and only when the sender
		 * may decide it (see may_decide()). A refused decision leaves
		 * the proposal open.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $room        Room identifier.
		 * @param int    $client_id   Client identifier.
		 * @param string $actor_id    The sender.
		 * @param array  $resolutions Decision rows, from decode_updates().
		 * @param array  $state       Room state. Updated.
		 * @return array|WP_Error The places (in `$resolutions`) of the
		 *                        refused decisions as keys, or a storage error.
		 */
		private function apply_decisions( string $room, int $client_id, string $actor_id, array $resolutions, array &$state ) {
			$refused_decisions = array();
			foreach ( $resolutions as $index => $resolution ) {
				$proposal_id = $resolution['proposalId'];
				if ( isset( $state['proposals_open'][ $proposal_id ] ) && ! isset( $state['resolved'][ $proposal_id ] ) ) {
					if ( ! self::may_decide( $state['proposals_open'][ $proposal_id ], $resolution['resolution'] ) ) {
						$refused_decisions[ $index ] = true;
						// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
						do_action( 'qm/debug', "wp-sync: refused a review decision in {$room} (the sender may not decide this item)" );
						continue;
					}
					$stored = $this->add_row(
						$room,
						$client_id,
						self::UPDATE_TYPE_RESOLVED,
						array(
							'proposalId' => $proposal_id,
							'resolution' => $resolution['resolution'],
							'resolvedBy' => $actor_id,
							'time'       => time(),
						)
					);
					if ( ! $stored ) {
						return new WP_Error(
							'rest_sync_storage_error',
							__( 'Failed to store sync update.', 'gutenberg' ),
							array( 'status' => 500 )
						);
					}
					$state['resolved'][ $proposal_id ] = true;
				}
			}

			return $refused_decisions;
		}

		/**
		 * Builds the answer: one verdict per row, in the order sent.
		 *
		 * @since n.e.x.t
		 *
		 * @param array[] $answers             One entry per row, from decode_updates().
		 * @param array   $state               Room state after the commit.
		 * @param array   $stale               Edits refused as `stale-base`.
		 * @param array   $cancel_dispositions Cancel id => answer.
		 * @param array   $refused_decisions   Places of the refused decisions.
		 * @return array[] The verdicts.
		 */
		private static function build_answers( array $answers, array $state, array $stale, array $cancel_dispositions, array $refused_decisions ): array {
			$dispositions = array();
			foreach ( $answers as $answer ) {
				$id = $answer['id'];
				switch ( $answer['kind'] ) {
					case 'intent':
						$dispositions[] = array_merge(
							array( 'intentId' => $id ),
							$state['settled'][ $id ]
								?? $stale[ $id ]
								?? $answer['verdict']
								?? array( 'status' => 'unknown' )
						);
						break;
					case 'resolution':
						if ( isset( $refused_decisions[ $answer['index'] ] ) ) {
							$dispositions[] = array(
								'intentId' => $id,
								'status'   => 'refused',
								'reason'   => 'not-allowed',
							);
							break;
						}
						$dispositions[] = array(
							'intentId' => $id,
							'status'   => 'resolved',
						);
						break;
					case 'cancel':
						$dispositions[] = array_merge( array( 'intentId' => $id ), $cancel_dispositions[ $id ] );
						break;
					default:
						$dispositions[] = $answer['verdict'];
				}
			}

			return $dispositions;
		}

		/**
		 * Reads the rows of one request and sorts them into edits, review
		 * decisions and cancellations.
		 *
		 * A row that cannot be used is refused by itself and never fails
		 * the request: one bad row (a client bug, or a hostile crafted
		 * row) must not keep the good edits beside it from being stored,
		 * which would leave their author sending them again forever.
		 *
		 * Every row gets one entry in `answers`, in the order sent, so
		 * the sender gets one answer per row. An entry is one of:
		 *
		 * - `intent`: an edit. Its verdict is known after the commit. A
		 *   malformed edit with a readable id carries its refusal as
		 *   `verdict`, used unless the id already has a stored verdict.
		 *   The first row with an id decides for that id: `refusals`
		 *   lists the ids whose first row was malformed, for the commit
		 *   to store, and a later good row with such an id is not used.
		 * - `resolution` or `cancel`: a usable review decision or
		 *   cancellation, answered by the commit. A `resolution` carries
		 *   its place in `resolutions` as `index`.
		 * - `refused`: a complete refusal. A row with no readable id is
		 *   named by `row`, its place in the request counted from 0.
		 *
		 * @since n.e.x.t
		 *
		 * @param array  $updates  Typed updates as sent.
		 * @param string $actor_id The sender, stamped on every edit.
		 * @param int    $head_seq The newest position in the room.
		 * @return array{intents: array[], resolutions: array[], cancels: array[], answers: array[], refusals: array<string, array>, refused: int}
		 */
		private static function decode_updates( array $updates, string $actor_id, int $head_seq ): array {
			$intents     = array();
			$resolutions = array();
			$cancels     = array();
			$answers     = array();
			$refusals    = array();
			$seen        = array();
			$refused     = 0;

			$refuse = static function ( int $row, ?string $id, string $reason ) use ( &$answers, &$refused ): void {
				$verdict = array(
					'status' => 'voided',
					'reason' => $reason,
				);
				if ( null === $id ) {
					$verdict = array_merge( array( 'row' => $row ), $verdict );
				} else {
					$verdict = array_merge( array( 'intentId' => $id ), $verdict );
				}
				$answers[] = array(
					'kind'    => 'refused',
					'id'      => $id,
					'verdict' => $verdict,
				);
				++$refused;
			};

			foreach ( array_values( $updates ) as $row => $update ) {
				$type    = is_array( $update ) ? ( $update['type'] ?? null ) : null;
				$data    = is_array( $update ) ? ( $update['data'] ?? null ) : null;
				$decoded = is_string( $data ) ? json_decode( $data, true ) : null;
				$decoded = is_array( $decoded ) ? $decoded : array();

				if ( self::UPDATE_TYPE_RESOLVED === $type ) {
					$proposal_id = self::readable_id( $decoded, 'proposalId' );
					if ( null === $proposal_id || ! in_array( $decoded['resolution'] ?? null, array( 'restored', 'dismissed' ), true ) ) {
						$refuse( $row, $proposal_id, 'invalid-payload' );
						continue;
					}
					$resolutions[] = $decoded;
					$answers[]     = array(
						'kind'  => 'resolution',
						'id'    => $proposal_id,
						'index' => count( $resolutions ) - 1,
					);
					continue;
				}

				if ( self::UPDATE_TYPE_CANCEL === $type ) {
					$cancel_id = self::readable_id( $decoded, 'cancelId' );
					if ( null === $cancel_id || ! is_array( $decoded['intentIds'] ?? null ) || array() === $decoded['intentIds'] ) {
						$refuse( $row, $cancel_id, 'invalid-payload' );
						continue;
					}
					$cancels[] = $decoded;
					$answers[] = array(
						'kind' => 'cancel',
						'id'   => $cancel_id,
					);
					continue;
				}

				if ( self::UPDATE_TYPE_INTENT !== $type ) {
					// A tab may send edits, cancellations and review
					// decisions. The other row types are the server's.
					$refuse( $row, null, 'invalid-type' );
					continue;
				}

				$intent    = $decoded;
				$intent_id = self::readable_id( $intent, 'intentId' );
				if ( null === $intent_id ) {
					$refuse( $row, null, 'invalid-payload' );
					continue;
				}

				$envelope_ok = ! array_key_exists( 'textSlices', $intent ) &&
					! array_key_exists( 'authoredPayload', $intent ) &&
					is_int( $intent['baseSeq'] ?? null ) && $intent['baseSeq'] >= 0 &&
					$intent['baseSeq'] <= $head_seq &&
					is_string( $intent['type'] ?? null ) &&
					is_array( $intent['payload'] ?? null ) &&
					( null === ( $intent['txnId'] ?? null ) || is_string( $intent['txnId'] ) );
				// Payloads reach typed planner/document code: validate the
				// full vocabulary schema up front so a malformed intent
				// voids cleanly instead of fataling mid-plan.
				$usable = $envelope_ok;
				// The planner checks the id and the type of an inserted
				// block and of each child. The rest of the body is checked
				// here, and first: the planner's check walks the children
				// and expects them to be a list.
				if ( $usable && 'insert_block' === $intent['type'] ) {
					$usable = self::is_usable_block_body( $intent['payload']['block'] ?? null );
				}
				$usable = $usable && WP_Intent_Log_Planner::is_valid_payload( $intent['type'], $intent['payload'] );
				if ( ! $usable ) {
					$verdict = array(
						'status' => 'voided',
						'reason' => 'invalid-payload',
					);
					if ( ! isset( $seen[ $intent_id ] ) ) {
						$refusals[ $intent_id ] = $verdict;
					}
					$seen[ $intent_id ] = true;
					$answers[]          = array(
						'kind'    => 'intent',
						'id'      => $intent_id,
						'verdict' => $verdict,
					);
					++$refused;
					continue;
				}

				$seen[ $intent_id ] = true;
				$answers[]          = array(
					'kind'    => 'intent',
					'id'      => $intent_id,
					'verdict' => $refusals[ $intent_id ] ?? null,
				);
				if ( isset( $refusals[ $intent_id ] ) ) {
					// An earlier row of this request already refused the id.
					continue;
				}

				// Attribution is a server-side fact: stamp, never trust.
				// So is the position, which the commit stamps on storing.
				unset( $intent['seq'] );
				$intent['actorId'] = $actor_id;
				$intent['txnId']   = $intent['txnId'] ?? null;
				$intents[]         = $intent;
			}

			return array(
				'intents'     => $intents,
				'resolutions' => $resolutions,
				'cancels'     => $cancels,
				'answers'     => $answers,
				'refusals'    => $refusals,
				'refused'     => $refused,
			);
		}

		/**
		 * Whether the current user may decide an open review item.
		 *
		 * An ordinary merge item is open to everyone who can edit the
		 * post, which the transport has already checked. An edit held
		 * because its author may not publish its markup is different:
		 * approving it publishes that markup, so only a user with
		 * `unfiltered_html` may approve it. Dismissing it throws the held
		 * edit away, which its author may also do.
		 *
		 * @since n.e.x.t
		 *
		 * @param array  $proposal   The open item: `reason` and `actorId`.
		 * @param string $resolution `restored` (approve) or `dismissed`.
		 * @return bool Whether the decision is allowed.
		 */
		private static function may_decide( array $proposal, string $resolution ): bool {
			if ( self::ESCALATION_REQUIRES_APPROVAL !== $proposal['reason'] ) {
				return true;
			}
			if ( current_user_can( 'unfiltered_html' ) ) {
				return true;
			}

			// The actor id is `u{user id}c{client id}`, stamped by the server.
			$is_author = 0 === strpos( (string) $proposal['actorId'], 'u' . get_current_user_id() . 'c' );

			return 'dismissed' === $resolution && $is_author;
		}

		/**
		 * Whether the body of an inserted block has the types the document
		 * code expects: text that is a string, formats that are a list of
		 * ranges, attributes that are a map, and children built the same
		 * way. A body of another shape would be stored as sent and then
		 * raise a PHP error whenever the room is read.
		 *
		 * The planner checks the id and the block type, of the block and
		 * of each child (see `is_valid_payload()`). This check runs before
		 * it, so it makes no assumption about either.
		 *
		 * @since n.e.x.t
		 *
		 * @param mixed $block The block as sent.
		 * @return bool Whether the body can be stored.
		 */
		private static function is_usable_block_body( $block ): bool {
			if ( ! is_array( $block ) ) {
				return false;
			}
			foreach ( array( 'attrs', 'attrVersions', 'fields', 'children' ) as $key ) {
				if ( array_key_exists( $key, $block ) && ! is_array( $block[ $key ] ) ) {
					return false;
				}
			}
			foreach ( $block['attrVersions'] ?? array() as $version ) {
				if ( ! is_int( $version ) || $version < 0 ) {
					return false;
				}
			}
			if ( null !== ( $block['syncParent'] ?? null ) && ! is_string( $block['syncParent'] ) ) {
				return false;
			}

			// Text and formats may sit on the block itself, as a short form
			// of the `content` field.
			if ( ! self::is_usable_field( $block ) ) {
				return false;
			}
			foreach ( $block['fields'] ?? array() as $name => $field ) {
				if ( ! is_string( $name ) || '' === $name || ! is_array( $field ) || ! self::is_usable_field( $field ) ) {
					return false;
				}
			}
			foreach ( $block['children'] ?? array() as $child ) {
				if ( ! self::is_usable_block_body( $child ) ) {
					return false;
				}
			}

			return true;
		}

		/**
		 * Whether `text` and `formats`, where present, are a string and a
		 * list of `{ start, end, format }` ranges.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $field A field of an inserted block, or the block
		 *                     itself for the short form.
		 * @return bool Whether both have the expected types.
		 */
		private static function is_usable_field( array $field ): bool {
			if ( array_key_exists( 'text', $field ) && ! is_string( $field['text'] ) ) {
				return false;
			}
			if ( ! array_key_exists( 'formats', $field ) ) {
				return true;
			}
			if ( ! is_array( $field['formats'] ) ) {
				return false;
			}
			foreach ( $field['formats'] as $range ) {
				if (
					! is_array( $range ) ||
					! is_int( $range['start'] ?? null ) || $range['start'] < 0 ||
					! is_int( $range['end'] ?? null ) || $range['end'] < $range['start'] ||
					! is_string( $range['format'] ?? null ) || '' === $range['format']
				) {
					return false;
				}
			}

			return true;
		}

		/**
		 * Whether a list of stored rows holds an edit with no `seq`: the
		 * mark of a room written before edits carried their position. A
		 * text search, so a tab's first read of a long room stays cheap.
		 *
		 * @since n.e.x.t
		 *
		 * @param array[] $rows Stored rows (`type`, `data`).
		 * @return bool Whether such an edit is among them.
		 */
		private static function has_unnumbered_edit( array $rows ): bool {
			foreach ( $rows as $row ) {
				if ( self::UPDATE_TYPE_INTENT === ( $row['type'] ?? null ) && false === strpos( (string) ( $row['data'] ?? '' ), '"seq":' ) ) {
					return true;
				}
			}

			return false;
		}

		/**
		 * The id a row carries under a key, when it is a non-empty string.
		 *
		 * @since n.e.x.t
		 *
		 * @param array  $decoded The row's decoded data.
		 * @param string $key     The key that holds the id.
		 * @return string|null The id, or null when there is none to read.
		 */
		private static function readable_id( array $decoded, string $key ): ?string {
			$id = $decoded[ $key ] ?? null;

			return is_string( $id ) && '' !== $id ? $id : null;
		}

		/**
		 * Whether an HTML fragment carries markup the kses post filter would
		 * alter — content a user without `unfiltered_html` could not have
		 * authored through a normal filtered save.
		 *
		 * @since 7.2.0
		 *
		 * @param string $html Fragment.
		 * @return bool True when protected.
		 */
		private static function fragment_requires_unfiltered_html( string $html ): bool {
			return wp_kses_post( $html ) !== $html;
		}

		/**
		 * Whether a rich-text span format id would emit protected markup.
		 *
		 * Object formats (`obj|{"html":…}`) re-emit their HTML verbatim, so
		 * the embedded fragment is checked directly. Element formats are run
		 * through the codec's own serializer so the exact emitted bytes are
		 * what kses judges. Malformed ids are protected: never trust what
		 * cannot be fully understood.
		 *
		 * @since 7.2.0
		 *
		 * @param string $format Span format id.
		 * @return bool True when protected.
		 */
		private static function format_requires_unfiltered_html( string $format ): bool {
			$pipe = strpos( $format, '|' );
			$tag  = false === $pipe ? $format : substr( $format, 0, $pipe );
			if ( 'obj' === $tag ) {
				$args = json_decode( substr( $format, $pipe + 1 ), true );
				if ( ! is_array( $args ) || ! is_string( $args['html'] ?? null ) ) {
					return true;
				}
				return self::fragment_requires_unfiltered_html( $args['html'] );
			}
			$decoded = WP_Intent_Log_Rich_Text::decode_format( $format );
			if (
				null === $decoded ||
				! is_array( $decoded['attrs'] ) ||
				! preg_match( '/^[a-z][a-z0-9-]*$/', $decoded['tag'] )
			) {
				return true;
			}
			foreach ( $decoded['attrs'] as $name => $value ) {
				if ( ! is_string( $name ) || ! is_string( $value ) ) {
					return true;
				}
			}
			$html = WP_Intent_Log_Rich_Text::field_to_html(
				array(
					'text'    => 'x',
					'formats' => array(
						array(
							'start'  => 0,
							'end'    => 1,
							'format' => $format,
						),
					),
				)
			);
			return self::fragment_requires_unfiltered_html( $html );
		}

		/**
		 * Whether a `_wrapper` internal attr would emit protected markup.
		 * materialize() rebuilds the wrapper's open/close fragments VERBATIM
		 * around the field content, so they are judged as a fragment.
		 *
		 * @since 7.2.0
		 *
		 * @param mixed $wrapper The _wrapper attr value.
		 * @return bool True when protected.
		 */
		private static function wrapper_requires_unfiltered_html( $wrapper ): bool {
			if ( ! is_array( $wrapper ) ) {
				return true;
			}
			$open  = $wrapper['open'] ?? '';
			$close = $wrapper['close'] ?? '';
			if ( ! is_string( $open ) || ! is_string( $close ) ) {
				return true;
			}
			return self::fragment_requires_unfiltered_html( $open . 'x' . $close );
		}

		/**
		 * Whether an attribute value carries protected markup in any string
		 * leaf (recursively).
		 *
		 * Attribute strings are NOT merely comment-JSON: blocks whose save()
		 * emits an attribute as raw markup (core/html `content` being the
		 * canonical case — it has no html/rich-text source, so it rides the
		 * attr lane, not the codec field lane) round-trip attr strings
		 * straight into post_content on the next privileged save.
		 *
		 * @since 7.2.0
		 *
		 * @param mixed $value Attribute value.
		 * @return bool True when protected.
		 */
		private static function attr_value_requires_unfiltered_html( $value ): bool {
			if ( is_string( $value ) ) {
				return self::fragment_requires_unfiltered_html( $value );
			}
			if ( is_array( $value ) ) {
				foreach ( $value as $item ) {
					if ( self::attr_value_requires_unfiltered_html( $item ) ) {
						return true;
					}
				}
			}
			// Numbers, booleans, and null carry no markup.
			return false;
		}

		/**
		 * Whether a block spec carries markup its author may not publish
		 * without `unfiltered_html`.
		 *
		 * Judges the `_wrapper` internal attr, every other attr's string
		 * leaves, the block-level and per-field format spans, and recurses
		 * into child block specs.
		 *
		 * @since 7.2.0
		 *
		 * @param array $block Block spec (make_block() shape).
		 * @return bool True when the spec requires `unfiltered_html`.
		 */
		private static function block_spec_requires_unfiltered_html( array $block ): bool {
			/*
			 * Attributes: the _wrapper internal attr re-emits as raw markup
			 * on materialize; every OTHER attr's string leaves are judged
			 * too, because blocks like core/html render an attr as raw
			 * markup client-side (see attr_value_requires_unfiltered_html).
			 */
			$attrs = is_array( $block['attrs'] ?? null ) ? $block['attrs'] : array();
			foreach ( $attrs as $key => $value ) {
				$protected = '_wrapper' === $key
					? self::wrapper_requires_unfiltered_html( $value )
					: self::attr_value_requires_unfiltered_html( $value );
				if ( $protected ) {
					return true;
				}
			}
			// make_block() also accepts block-level text/formats shorthand
			// (they become the content field); judge both shapes.
			$span_lists = array( $block['formats'] ?? array() );
			foreach ( $block['fields'] ?? array() as $field ) {
				$span_lists[] = is_array( $field ) ? ( $field['formats'] ?? array() ) : array();
			}
			foreach ( $span_lists as $spans ) {
				foreach ( $spans as $span ) {
					$format = is_array( $span ) ? ( $span['format'] ?? null ) : null;
					if ( ! is_string( $format ) || self::format_requires_unfiltered_html( $format ) ) {
						return true;
					}
				}
			}
			foreach ( $block['children'] ?? array() as $child ) {
				if ( self::block_spec_requires_unfiltered_html( $child ) ) {
					return true;
				}
			}
			return false;
		}

		/**
		 * Whether applying this intent would introduce markup its author may
		 * not publish without `unfiltered_html`.
		 *
		 * Markup-bearing payload surfaces: format_text (the span format id,
		 * whether turning it on OR off), insert_block (the block spec's field
		 * formats, plus every attr's string leaves), set_attr (string
		 * leaves; blocks like core/html render an attr as raw markup), and
		 * set_property (string values — title and excerpt are kses-filtered
		 * at save for authors without the capability, so markup kses would
		 * rewrite must not relay to peers unreviewed). Plain text payloads
		 * (field text) are entity-encoded by the serializer and are always
		 * safe.
		 *
		 * @since 7.2.0
		 *
		 * @param array $intent Validated intent envelope.
		 * @return bool True when the intent requires the capability.
		 */
		public static function intent_requires_unfiltered_html( array $intent ): bool {
			$payload = $intent['payload'];
			switch ( $intent['type'] ) {
				case 'format_text':
					/*
					 * Judged in BOTH directions. Applying a protected format
					 * is the obvious case. REMOVING one is gated too: a
					 * filtered author's change to protected markup derives
					 * as an off/on format pair (a custom HTML block edit is
					 * the canonical case), and letting the off half apply
					 * would strip the previously approved markup out of the
					 * canonical document while the on half parks. Parking
					 * both keeps the block at its approved content until
					 * review, and restoring re-authors the pair.
					 */
					return self::format_requires_unfiltered_html( $payload['format'] );
				case 'insert_block':
					return self::block_spec_requires_unfiltered_html( $payload['block'] );
				case 'set_attr':
					// _wrapper re-emits as raw markup on materialize; other
					// attrs can be rendered raw by the block's own save()
					// (core/html) — judge their string leaves.
					return '_wrapper' === $payload['key']
						? self::wrapper_requires_unfiltered_html( $payload['value'] )
						: self::attr_value_requires_unfiltered_html( $payload['value'] );
				case 'set_property':
					// String values judged like attr string leaves; numbers,
					// booleans, and null carry no markup.
					return self::attr_value_requires_unfiltered_html( $payload['value'] );
				default:
					return false;
			}
		}

		/**
		 * A short plain-text excerpt of an escalated intent's target field,
		 * for content-centric review rendering.
		 *
		 * @since 7.2.0
		 *
		 * @param array $doc    Document at settlement.
		 * @param array $intent The escalated intent (transformed form).
		 * @return string Excerpt (possibly empty).
		 */
		private static function proposal_excerpt( array $doc, array $intent ): string {
			$payload = $intent['payload'];
			$sync_id = $payload['syncId'] ?? $payload['survivorId'] ?? null;
			if ( ! is_string( $sync_id ) ) {
				return '';
			}
			$block = WP_Intent_Log_Document::get_block( $doc, $sync_id );
			if ( null === $block ) {
				return '';
			}
			$field = $payload['field'] ?? 'content';
			$text  = $block['fields'][ $field ]['text'] ?? '';
			return WP_Intent_Log_Document::text_slice( $text, 0, 80 );
		}

		/**
		 * Appends a compaction checkpoint and trims history behind the
		 * PREVIOUS checkpoint once the retained window reaches the interval.
		 *
		 * Retention invariant: rows from the previous checkpoint onward are
		 * always kept, so any client within one full checkpoint interval of
		 * the head resumes normally. Older clients hit the floor and receive
		 * the retained checkpoint as a reset snapshot. Parked rows that
		 * would fall behind the floor are re-appended first — escalated work
		 * parked for review must survive compaction.
		 *
		 * Requires the storage to expose per-room metadata (the post-meta
		 * storage does); silently skips checkpointing otherwise.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room               Room identifier.
		 * @param int    $client_id          Requesting client id (row attribution).
		 * @param int    $window_intent_rows Intent rows since the newest
		 *                                   stored snapshot, after this commit.
		 * @param int    $head_seq           Engine seq at the new head.
		 * @param array  $head_doc           Document at the new head.
		 * @return bool Whether a checkpoint was appended.
		 */
		private function maybe_checkpoint( string $room, int $client_id, int $window_intent_rows, int $head_seq, array $head_doc ): bool {
			if ( ! method_exists( $this->storage, 'get_room_meta' ) || ! method_exists( $this->storage, 'set_room_meta' ) ) {
				return false;
			}

			/**
			 * Filters the intent-log checkpoint interval: a compaction
			 * checkpoint is appended once this many intent rows accumulate
			 * since the previous one.
			 *
			 * The default is sized for LIVE authoring frames, not just
			 * storage: the one-sided transform needs the priors between a
			 * client's observed frame and the head, and the trim keeps only
			 * rows from the PREVIOUS checkpoint onward. Two collaborators
			 * typing concurrently burn ~2 rows per keystroke (per-keystroke
			 * transports deliver them as fast), and an observed frame only
			 * advances past a peer's rows when the editor renders a push —
			 * which waits out the typing burst. At 100, two typists crossed
			 * the floor after ~48 keystrokes each and the burst tails voided
			 * as stale-base (found by the real-websocket e2e lane). Intent
			 * rows are small JSON, so a 500-row interval (≤1000 retained
			 * rows) stays a modest, bounded tail.
			 *
			 * @since 7.2.0
			 *
			 * @param int    $interval Interval in intent rows.
			 * @param string $room     Room identifier.
			 */
			$interval = (int) apply_filters( 'wp_sync_intent_log_checkpoint_interval', 500, $room );
			if ( $interval < 1 || $window_intent_rows < $interval ) {
				return false;
			}

			$previous = $this->storage->get_room_meta( $room, 'intent_log_checkpoint' );

			// UNRESOLVED escalated work parked below the future floor
			// survives by re-appending it above the new checkpoint's
			// predecessor; resolved pairs age out with the trim (the
			// retention rule — see PROPOSAL-REVIEW.md).
			if ( is_array( $previous ) && isset( $previous['cursor'] ) ) {
				$rows           = $this->storage->get_updates_after_cursor( $room, 0 );
				$below          = array();
				$resolved_ids   = array();
				$found_previous = false;
				foreach ( $rows as $row ) {
					$decoded = json_decode( $row['data'], true );
					if ( is_array( $decoded ) && self::UPDATE_TYPE_RESOLVED === $row['type'] && isset( $decoded['proposalId'] ) ) {
						$resolved_ids[ $decoded['proposalId'] ] = true;
					}
				}
				foreach ( $rows as $row ) {
					$decoded = json_decode( $row['data'], true );
					if ( ! is_array( $decoded ) ) {
						continue;
					}
					if (
						self::UPDATE_TYPE_SNAPSHOT === $row['type'] &&
						! empty( $decoded['checkpoint'] ) &&
						(int) ( $decoded['seq'] ?? -1 ) === (int) ( $previous['seq'] ?? -2 )
					) {
						$found_previous = true;
						break;
					}
					if (
						self::UPDATE_TYPE_PARKED === $row['type'] &&
						! isset( $resolved_ids[ $decoded['intent']['intentId'] ?? '' ] )
					) {
						$below[] = $decoded;
					}
				}
				if ( $found_previous ) {
					foreach ( $below as $proposal ) {
						$this->add_row( $room, 0, self::UPDATE_TYPE_PARKED, $proposal );
					}
				}
			}

			$stored = $this->add_row(
				$room,
				$client_id,
				self::UPDATE_TYPE_SNAPSHOT,
				array(
					'doc'        => $head_doc,
					'seq'        => $head_seq,
					'checkpoint' => true,
				)
			);
			if ( ! $stored ) {
				return false; // Non-fatal: the next commit retries.
			}
			// The checkpoint row's own transport cursor: the storage writes
			// postmeta directly, so the connection's last insert id IS the
			// row's meta_id (the storage's cached get_cursor() is stale
			// until the next read).
			global $wpdb;
			$cursor = (int) $wpdb->insert_id;
			if ( $cursor <= 0 ) {
				return true;
			}
			// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
			do_action( 'qm/debug', "wp-sync: checkpoint at seq {$head_seq} for {$room}" );
			$this->storage->set_room_meta(
				$room,
				'intent_log_checkpoint',
				array(
					'seq'    => $head_seq,
					'cursor' => $cursor,
				)
			);

			if ( is_array( $previous ) && isset( $previous['cursor'] ) ) {
				// Trim everything BELOW the previous checkpoint row (it
				// stays: it is the reset bootstrap for stale cursors) and
				// record the floor for the read path.
				$this->storage->remove_updates_before_cursor( $room, (int) $previous['cursor'] );
				$this->storage->set_room_meta( $room, 'intent_log_floor', (int) $previous['cursor'] );
				// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
				do_action( 'qm/debug', "wp-sync: trimmed history below cursor {$previous['cursor']} for {$room}" );
			}
			return true;
		}

		/**
		 * Returns rows after the cursor for a catching-up client.
		 *
		 * Unlike the relay engine, a client's OWN rows are not filtered out:
		 * the author needs the authoritative transformed form of its accepted
		 * intents in its local log copy for prediction parity.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Client identifier.
		 * @param int    $cursor    Return rows after this cursor.
		 * @param array  $context   Transport context.
		 * @return array Room response data.
		 */
		public function get_updates_since( string $room, int $client_id, int $cursor, array $context ): array {
			/*
			 * Compaction floor: a cursor below the trimmed history cannot be
			 * caught up row-by-row (its missing rows are gone). Serve from
			 * the retained checkpoint row instead — the client receives it
			 * as a reset snapshot and re-bootstraps.
			 */
			if ( $cursor > 0 && method_exists( $this->storage, 'get_room_meta' ) ) {
				$floor = $this->storage->get_room_meta( $room, 'intent_log_floor' );
				if ( is_numeric( $floor ) && $cursor < (int) $floor ) {
					$cursor = (int) $floor - 1;
				}
			}

			$rows = $this->storage->get_updates_after_cursor( $room, $cursor );

			/*
			 * A room that holds no row at all has no first document yet.
			 * Build it, so the first tab receives the snapshot. The check
			 * comes after the read on purpose: the storage only knows the
			 * room's newest row once it has read, and a long-lived process
			 * may hold a position from before another process reset the
			 * room. A room that holds rows needs nothing more than the
			 * rows, so an ordinary poll never rebuilds the room's state.
			 */
			if ( 0 === $this->storage->get_cursor( $room ) || ( 0 === $cursor && self::has_unnumbered_edit( $rows ) ) ) {
				// The second case is a room written before edits carried
				// their position. Loading it resets it (see load_room()).
				$this->load_room( $room );
				$rows = $this->storage->get_updates_after_cursor( $room, $cursor );
			}

			$typed_updates = array();
			foreach ( $rows as $row ) {
				$typed_updates[] = array(
					'data' => $row['data'],
					'type' => $row['type'],
				);
			}

			$response = array(
				'end_cursor'     => $this->storage->get_cursor( $room ),
				'room'           => $room,
				'should_compact' => false,
				'total_updates'  => $this->storage->get_update_count( $room ),
				'updates'        => $typed_updates,
			);

			// The room's newest position, when this request committed. The
			// tab compares it with the rows it has, to notice a missing one.
			if ( isset( $this->head_seq_stash[ $room ] ) ) {
				$response['seq'] = $this->head_seq_stash[ $room ];
				unset( $this->head_seq_stash[ $room ] );
			}

			// The debug envelope: engine facts from this request's ingest
			// half (the stash) plus read-side counts. Attached only when
			// the request opted in AND the site allows it (transport gate).
			if ( ! empty( $context['debug'] ) ) {
				$response['_debug'] = array_merge(
					$this->debug_stash[ $room ] ?? array(),
					array(
						'rows_returned' => count( $typed_updates ),
						'total_rows'    => $response['total_updates'],
					)
				);
				unset( $this->debug_stash[ $room ] );
			}

			return $response;
		}

		/**
		 * The engine document at an absolute log seq — the machine-writer
		 * preflight's diff base.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room Room identifier.
		 * @param int    $seq  Absolute log seq.
		 * @return array|null Engine document, or null when the room is
		 *                    uninitialized or the seq is outside the
		 *                    retained window (below the floor / past head).
		 */
		public function document_at( string $room, int $seq ) {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) || ! is_array( $state['genesis'] ?? null ) ) {
				return null;
			}
			$base_seq = (int) ( $state['base_seq'] ?? 0 );
			$head_seq = $base_seq + count( $state['log'] );
			if ( $seq < $base_seq || $seq > $head_seq ) {
				return null;
			}

			return self::document_at_seq( $state, $seq );
		}

		/**
		 * The document at a position inside a loaded room's history,
		 * replayed from the nearest stored snapshot at or before it.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $state Room state from load_room().
		 * @param int   $seq   A position from `base_seq` to the head.
		 * @return array Engine document.
		 */
		private static function document_at_seq( array $state, int $seq ): array {
			$from_seq = (int) $state['base_seq'];
			$from_doc = $state['genesis'];
			if ( $seq >= $state['snapshot_seq'] ) {
				$from_seq = (int) $state['snapshot_seq'];
				$from_doc = $state['snapshot_doc'];
			}

			return WP_Intent_Log_Document::replay(
				$from_doc,
				array_slice( $state['log'], $from_seq - (int) $state['base_seq'], $seq - $from_seq )
			);
		}

		/**
		 * The room's current head seq, or null pre-genesis.
		 *
		 * @since 0.5.0
		 *
		 * @param string $room Room identifier.
		 * @return int|null Head seq.
		 */
		public function head_seq( string $room ): ?int {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) || ! is_array( $state['genesis'] ?? null ) ) {
				return null;
			}

			return (int) ( $state['base_seq'] ?? 0 ) + count( $state['log'] );
		}

		/**
		 * Materializes the room's document as serialized post content by
		 * replaying the accepted log over the genesis snapshot.
		 *
		 * @param string $room Room identifier.
		 * @return string|null Serialized block content, or null when the
		 *                     room cannot be loaded.
		 */
		public function materialize( string $room ): ?string {
			$state = $this->load_room( $room );
			if ( is_wp_error( $state ) ) {
				return null;
			}
			$doc = self::document_at_seq( $state, (int) $state['base_seq'] + count( $state['log'] ) );

			$serialized = array();
			foreach ( $doc['root'] as $block ) {
				$serialized[] = serialize_block( self::to_serializable_block( $block ) );
			}

			return implode( "\n\n", $serialized );
		}

		/**
		 * Loads (and lazily initializes) a room's engine state from storage.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room Room identifier.
		 * @return array|WP_Error array( 'genesis', 'log', 'settled' ).
		 */
		private function load_room( string $room ) {
			$kept = $this->room_state[ $room ] ?? null;
			if ( null !== $kept ) {
				/*
				 * Use the kept copy only while the row it was loaded at is
				 * still the room's newest. Another process may have written
				 * or reset the room since: a polling request beside the
				 * WebSocket daemon, a script save, or a tab that left.
				 */
				$newer = $this->storage->get_updates_after_cursor( $room, $kept['cursor'] );
				if ( array() === $newer && $this->storage->get_cursor( $room ) === $kept['cursor'] ) {
					return $kept;
				}
				unset( $this->room_state[ $room ] );
			}

			$rows           = $this->storage->get_updates_after_cursor( $room, 0 );
			$cursor         = $this->storage->get_cursor( $room );
			$genesis        = null;
			$log            = array();
			$settled        = array();
			$proposals_open = array();
			$resolved       = array();
			$parked         = array();
			$base_seq       = 0;
			$snapshot_seq   = 0;
			$snapshot_doc   = null;
			$unnumbered     = false;

			foreach ( $rows as $row ) {
				$decoded = json_decode( $row['data'], true );
				if ( ! is_array( $decoded ) ) {
					continue;
				}
				switch ( $row['type'] ) {
					case self::UPDATE_TYPE_SNAPSHOT:
						$is_checkpoint = ! empty( $decoded['checkpoint'] );
						$seq           = $is_checkpoint ? (int) ( $decoded['seq'] ?? 0 ) : 0;
						if ( null === $genesis ) {
							/*
							 * The oldest stored snapshot is where the history
							 * starts: the room's first document, or the
							 * oldest checkpoint the trim kept. A second first
							 * document from a racing initializer is ignored,
							 * the same way on every server.
							 */
							$genesis      = $decoded['doc'];
							$base_seq     = $seq;
							$snapshot_seq = $seq;
							$snapshot_doc = $genesis;
						} elseif ( $is_checkpoint && $seq === $base_seq + count( $log ) ) {
							/*
							 * A later checkpoint. The edits before it stay in
							 * the history, with their verdicts, for as long
							 * as their rows are stored: an edit that was on
							 * its way when the checkpoint was written is
							 * still combined, and a repeat still gets its
							 * first verdict. The checkpoint only saves
							 * replaying those edits to reach the newest
							 * document.
							 */
							$snapshot_seq = $seq;
							$snapshot_doc = $decoded['doc'];
						} elseif ( $is_checkpoint ) {
							// The rows before it do not add up to its
							// position, so nothing before it can be used.
							$genesis      = $decoded['doc'];
							$base_seq     = $seq;
							$snapshot_seq = $seq;
							$snapshot_doc = $genesis;
							$log          = array();
							$settled      = array();
						}
						break;
					case self::UPDATE_TYPE_INTENT:
						if ( ! is_int( $decoded['seq'] ?? null ) ) {
							$unnumbered = true;
						}
						$log[]                           = $decoded;
						$settled[ $decoded['intentId'] ] = array( 'status' => 'applied' );
						break;
					case self::UPDATE_TYPE_PARKED:
						$settled[ $decoded['intent']['intentId'] ]        = array(
							'status' => 'escalated',
							'reason' => $decoded['reason'],
						);
						$proposals_open[ $decoded['intent']['intentId'] ] = array(
							'reason'  => $decoded['reason'],
							'actorId' => $decoded['actorId'] ?? '',
						);

						/*
						 * A planner escalation stays part of its author's
						 * frame until the author observes the clash
						 * (resolved or not): later batches from that actor
						 * plan from it (see seed_frame_state). The settling
						 * seq rides the row. A row written before it was
						 * recorded falls back to the head at parking, the
						 * conservative choice. Security holds are not frame
						 * phantoms and are left out.
						 */
						if ( self::ESCALATION_REQUIRES_APPROVAL !== $decoded['reason'] ) {
							$parked[ $decoded['actorId'] ][] = array(
								'intent' => $decoded['intent'],
								'atSeq'  => isset( $decoded['atSeq'] ) ? (int) $decoded['atSeq'] : (int) ( $decoded['at'] ?? 0 ) - 1,
							);
						}
						break;
					case self::UPDATE_TYPE_RESOLVED:
						unset( $proposals_open[ $decoded['proposalId'] ] );
						$resolved[ $decoded['proposalId'] ] = true;
						break;
					case self::UPDATE_TYPE_VOIDED:
						// Overrides an intent row's 'applied': apply-time
						// voids are in the log but settled as voided.
						$settled[ $decoded['intentId'] ] = array(
							'status' => 'voided',
							'reason' => $decoded['reason'],
						);
						break;
				}
			}

			/*
			 * A room written before edits carried their position cannot be
			 * read by today's tabs, and there is no conversion. It is
			 * reset: emptied here, under the lock, and given a new first
			 * document from the saved post just below. Edits in it that
			 * were never saved are lost.
			 */
			if ( $unnumbered && method_exists( $this->storage, 'reset_room' ) ) {
				if ( isset( $this->room_lock_tokens[ $room ] ) ) {
					$this->storage->reset_room( $room );
					// phpcs:ignore WordPress.NamingConventions.ValidHookName.UseUnderscores, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Query Monitor's debug hook.
					do_action( 'qm/debug', "wp-sync: reset room {$room} (written by an older protocol version)" );
				}
				$genesis        = null;
				$log            = array();
				$settled        = array();
				$proposals_open = array();
				$resolved       = array();
				$parked         = array();
				$base_seq       = 0;
				$snapshot_seq   = 0;
			}

			$created = false;
			if ( null === $genesis && ! isset( $this->room_lock_tokens[ $room ] ) ) {
				/*
				 * The room has no first document, and this is not a commit
				 * (a commit holds the lock already). A read is the usual
				 * first caller. Take the lock and look again: two readers
				 * that both find the room empty must not both store a
				 * first document, and a reset must not run in between.
				 */
				$lock = $this->acquire_room_lock( $room );
				if ( is_wp_error( $lock ) ) {
					return $lock;
				}
				try {
					return $this->load_room( $room );
				} finally {
					$this->release_room_lock( $room );
				}
			}
			if ( null === $genesis ) {
				$genesis = $this->initialize_room( $room );
				if ( is_wp_error( $genesis ) ) {
					return $genesis;
				}
				$snapshot_doc = $genesis;
				$created      = true;
			}

			// A park settled below the retained window is dropped from the
			// seed: it cannot affect any intent that can still be planned,
			// since stale bases are voided before planning.
			foreach ( $parked as $actor => $parks ) {
				$parked[ $actor ] = array_values(
					array_filter(
						$parks,
						static function ( $park ) use ( $base_seq ) {
							return $park['atSeq'] >= $base_seq;
						}
					)
				);
			}

			$state = array(
				'genesis'        => $genesis,
				'log'            => $log,
				'settled'        => $settled,
				// Review lifecycle: open proposals (escalations minus
				// resolutions), each with its reason and author, and
				// resolved ids, for resolution validation.
				'proposals_open' => $proposals_open,
				'resolved'       => $resolved,
				// Each actor's planner escalations with their settling seq:
				// the frame state the actor's next batch plans from.
				'parked'         => $parked,
				// Engine seq of the oldest stored snapshot (0, or that
				// checkpoint's seq): log[i] is engine seq base_seq + i.
				'base_seq'       => $base_seq,
				// The newest stored snapshot, a shortcut to recent
				// documents. Equal to the genesis when there is only one.
				'snapshot_seq'   => $snapshot_seq,
				'snapshot_doc'   => $snapshot_doc,
				// The id of the room's newest row when this was loaded.
				'cursor'         => $cursor,
			);

			// A first document that was only just stored is not kept: its
			// row id is not known here, so the next use loads the room.
			if ( ! $created ) {
				$this->room_state[ $room ] = $state;
			}

			return $state;
		}

		/**
		 * Entity property registers seeded into a post room's genesis.
		 *
		 * Delegates to the shared genesis-props helper so every engine
		 * seeds the identical REST-shaped property set (scalar whitelist
		 * gated on post-type supports, taxonomies by rest_base, registered
		 * post meta as `meta.<key>`).
		 *
		 * @since 7.2.0
		 *
		 * @param WP_Post $post The room's post.
		 * @return array Property name => raw scalar value.
		 */
		private static function genesis_props( WP_Post $post ): array {
			return WP_Sync_Post_Genesis_Props::for_post( $post );
		}

		/**
		 * Builds and stores the room's genesis snapshot.
		 *
		 * For a single post-type entity room, genesis derives from the post's
		 * current content: parsed blocks map onto the engine document, block
		 * identity comes from `metadata.syncId` when present and a
		 * deterministic genesis id otherwise. Other room kinds start empty.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room Room identifier.
		 * @return array|WP_Error Genesis document.
		 */
		private function initialize_room( string $room ) {
			$parsed  = WP_RTC_Config::parse_room( $room );
			$genesis = array( 'root' => array() );

			if ( null !== $parsed && 'postType' === $parsed['entity_kind'] && ! empty( $parsed['object_id'] ) ) {
				$post = get_post( (int) $parsed['object_id'] );
				if ( $post instanceof WP_Post ) {
					$specs = '' === $post->post_content
						? array()
						: self::blocks_to_specs(
							parse_blocks( $post->post_content ),
							(int) $post->ID,
							array()
						);
					// Entity properties are per-name registers on the
					// document; genesis seeds them from the post so a
					// joining client sees the current values.
					$genesis = WP_Intent_Log_Document::create_document(
						$specs,
						self::genesis_props( $post )
					);
				}
			}

			if ( ! $this->add_row( $room, 0, self::UPDATE_TYPE_SNAPSHOT, array( 'doc' => $genesis ) ) ) {
				return new WP_Error(
					'rest_sync_storage_error',
					__( 'Failed to store the room genesis snapshot.', 'gutenberg' ),
					array( 'status' => 500 )
				);
			}

			/*
			 * The genesis snapshot is the room's FIRST stored row, so it must
			 * stamp the engine lineage: the transport only stamps lineage on
			 * client-supplied updates, and a room whose first write is this
			 * server-initiated genesis would otherwise pass the lineage check
			 * (null) after a site-level engine flip — letting another engine
			 * append rows into a room already containing intent-log rows.
			 */
			$this->storage->set_room_engine( $room, $this->get_slug() );

			return $genesis;
		}

		/**
		 * Maps parsed blocks onto engine block specs.
		 *
		 * @since 7.2.0
		 *
		 * @param array $blocks  Output of parse_blocks().
		 * @param int   $post_id Post ID (genesis id input).
		 * @param array $path    Block path within the post.
		 * @return array Block specs for WP_Intent_Log_Document.
		 */
		public static function blocks_to_specs( array $blocks, int $post_id, array $path ): array {
			$specs = array();
			$index = 0;
			foreach ( $blocks as $block ) {
				if ( empty( $block['blockName'] ) ) {
					/*
					 * Null-name fragments: whitespace between blocks is
					 * noise, but a run with real content is CLASSIC
					 * content — the editor models it as core/freeform, and
					 * dropping it here would erase it from the shared
					 * document (and from every collaborator's editor).
					 * Freeform content is arbitrary multi-fragment HTML, so
					 * no wrapper stripping: the full run goes through the
					 * codec.
					 */
					$text = trim( $block['innerHTML'] );
					if ( '' === $text ) {
						continue;
					}
					$specs[] = array(
						'syncId'    => WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, array_merge( $path, array( $index ) ) ),
						'blockType' => 'core/freeform',
						'attrs'     => array(),
						'fields'    => array(
							'content' => WP_Intent_Log_Rich_Text::html_to_field( $text ),
						),
						'children'  => array(),
					);
					++$index;
					continue;
				}
				$block_path = array_merge( $path, array( $index ) );
				$attrs      = is_array( $block['attrs'] ) ? $block['attrs'] : array();

				$sync_id = $attrs['metadata']['syncId'] ?? null;
				if ( ! is_string( $sync_id ) || '' === $sync_id ) {
					$sync_id = WP_Intent_Log_Planner::genesis_sync_id( $post_id, 0, $block_path );
				} else {
					unset( $attrs['metadata']['syncId'] );
					if ( array() === $attrs['metadata'] ) {
						unset( $attrs['metadata'] );
					}
				}

				/*
				 * The editor's `content` attribute is the INNER HTML of a
				 * block's single wrapper element ('<p>Hi</p>' → 'Hi'), and
				 * the client bridge captures in that form — then through the
				 * rich-text codec into plain text + format spans (THE text
				 * coordinate space). Genesis must store the same form or
				 * every text offset disagrees between client and server.
				 * The stripped wrapper is kept in an internal `_wrapper`
				 * attr (excluded from client capture) so materialize() can
				 * rebuild the full markup.
				 */
				$text    = trim( $block['innerHTML'] );
				$wrapper = null;
				if ( preg_match( '/^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>(.*)<\/\1>$/s', $text, $matches ) ) {
					$wrapper = array(
						'open'  => '<' . $matches[1] . ( $matches[2] ?? '' ) . '>',
						'close' => '</' . $matches[1] . '>',
					);
					$text    = $matches[3];
				}
				if ( null !== $wrapper ) {
					$attrs['_wrapper'] = $wrapper;
				}

				$specs[] = array(
					'syncId'    => $sync_id,
					'blockType' => $block['blockName'],
					'attrs'     => $attrs,
					'fields'    => array(
						'content' => WP_Intent_Log_Rich_Text::html_to_field( $text ),
					),
					'children'  => self::blocks_to_specs( $block['innerBlocks'], $post_id, $block_path ),
				);
				++$index;
			}

			return $specs;
		}

		/**
		 * Maps an engine block back to a serialize_block()-compatible array.
		 *
		 * @since 7.2.0
		 *
		 * @param array $block Engine block.
		 * @return array WP_Block_Parser_Block-shaped array.
		 */
		private static function to_serializable_block( array $block ): array {
			// Classic content serializes BARE (null block name → no comment
			// delimiters, so no attrs and no persisted identity either —
			// freeform ids re-derive deterministically from genesis paths).
			if ( 'core/freeform' === $block['blockType'] ) {
				$text = WP_Intent_Log_Rich_Text::field_to_html(
					$block['fields']['content'] ?? array(
						'text'    => '',
						'formats' => array(),
					)
				);
				return array(
					'blockName'    => null,
					'attrs'        => array(),
					'innerBlocks'  => array(),
					'innerHTML'    => $text,
					'innerContent' => '' === $text ? array() : array( $text ),
				);
			}
			$attrs   = $block['attrs'];
			$wrapper = $attrs['_wrapper'] ?? null;
			unset( $attrs['_wrapper'] );
			$attrs['metadata']           = is_array( $attrs['metadata'] ?? null ) ? $attrs['metadata'] : array();
			$attrs['metadata']['syncId'] = $block['syncId'];

			$inner_blocks = array_map( array( __CLASS__, 'to_serializable_block' ), $block['children'] );
			$text         = WP_Intent_Log_Rich_Text::field_to_html(
				$block['fields']['content'] ?? array(
					'text'    => '',
					'formats' => array(),
				)
			);

			/*
			 * innerContent is an ORDERED interleave of HTML fragments and one
			 * null per inner block AT ITS POSITION. A container's wrapper must
			 * therefore split into an OPEN fragment before the child slots and
			 * a CLOSE fragment after them — concatenating open+close into one
			 * fragment serialized every child OUTSIDE its wrapper element, and
			 * the block validator rejected the materialized markup on the next
			 * parse (invalid-content recovery blocks after reload; found by
			 * the fuzzer's nested-group + save + reload lane).
			 */
			$open_fragment  = $text;
			$close_fragment = '';
			if ( is_array( $wrapper ) ) {
				$open_fragment  = ( $wrapper['open'] ?? '' ) . $text;
				$close_fragment = (string) ( $wrapper['close'] ?? '' );
			}
			$inner_content = array();
			if ( count( $inner_blocks ) > 0 ) {
				if ( '' !== $open_fragment ) {
					$inner_content[] = $open_fragment;
				}
				foreach ( $inner_blocks as $unused ) {
					$inner_content[] = null;
				}
				if ( '' !== $close_fragment ) {
					$inner_content[] = $close_fragment;
				}
			} else {
				$whole = $open_fragment . $close_fragment;
				if ( '' !== $whole ) {
					$inner_content[] = $whole;
				}
			}

			return array(
				'blockName'    => $block['blockType'],
				'attrs'        => $attrs,
				'innerBlocks'  => $inner_blocks,
				'innerHTML'    => $open_fragment . $close_fragment,
				'innerContent' => $inner_content,
			);
		}

		/**
		 * Stores one typed row for a room.
		 *
		 * @since 7.2.0
		 *
		 * @param string $room      Room identifier.
		 * @param int    $client_id Originating client id (0 = server).
		 * @param string $type      Row type.
		 * @param array  $payload   JSON-serializable payload.
		 * @return bool Whether the row was stored.
		 */
		private function add_row( string $room, int $client_id, string $type, array $payload ): bool {
			return $this->storage->add_update(
				$room,
				array(
					'client_id' => $client_id,
					'data'      => wp_json_encode( $payload ),
					'type'      => $type,
				)
			);
		}
	}
}
