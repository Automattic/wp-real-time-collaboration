<?php
/**
 * Gutenberg_Sync_Engines_Plugin class
 *
 * @package GutenbergSyncEngines
 */

if ( ! class_exists( 'Gutenberg_Sync_Engines_Plugin' ) ) {

	/**
	 * Plugin bootstrap: loads and registers the sync engines and transports
	 * this plugin provides, and the admin settings screen for selecting them.
	 *
	 * The plugin owns the whole server side: the WP_Sync_Engine,
	 * WP_Sync_Transport and WP_RTC_Storage contracts, the two registries,
	 * room names and permissions, the REST routes, and the settings printed
	 * for the browser (all under `includes/server/`), plus the engine and
	 * the transports that register through the `wp_sync_engines` and
	 * `wp_sync_transports` filters. The editor packages still come from the
	 * bundled Gutenberg, so beside any other Gutenberg the plugin stays
	 * dormant.
	 *
	 * @since 0.1.0
	 */
	final class Gutenberg_Sync_Engines_Plugin {
		/**
		 * Singleton instance.
		 *
		 * @since 0.1.0
		 * @var Gutenberg_Sync_Engines_Plugin|null
		 */
		private static ?Gutenberg_Sync_Engines_Plugin $instance = null;

		/**
		 * Whether the Gutenberg that is running is the bundled copy, whose
		 * editor packages the plugin's browser code needs.
		 *
		 * @since 0.1.0
		 * @var bool
		 */
		private bool $framework_available = false;

		/**
		 * Returns the singleton instance.
		 *
		 * @since 0.1.0
		 *
		 * @return Gutenberg_Sync_Engines_Plugin Instance.
		 */
		public static function instance(): Gutenberg_Sync_Engines_Plugin {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}

		/**
		 * Private constructor (use instance()).
		 *
		 * @since 0.1.0
		 */
		private function __construct() {}

		/**
		 * Boots the plugin: checks that the bundled Gutenberg is the one
		 * running, then loads and registers everything. Beside another
		 * Gutenberg the plugin stays dormant and shows an admin notice.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function boot(): void {
			/*
			 * The storage tables come first and do not depend on the
			 * framework: a plugin update that ships a newer schema upgrades
			 * here (activation hooks do not fire on updates), and the
			 * lifecycle CLI (`wp collaboration storage …`) must work on a
			 * site where the plugin is dormant. A site that cannot create
			 * the tables keeps working on the fallback storage
			 * (see wp_rtc_get_storage()) and is told so.
			 */
			if ( ! WP_Sync_Table_Schema::maybe_upgrade() ) {
				add_action( 'admin_notices', array( $this, 'render_storage_unavailable_notice' ) );
			}
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/storage/class-wp-sync-table-storage-cli-command.php';
			}

			// The plugin's browser code registers through the editor
			// packages of the bundled Gutenberg. Another Gutenberg does not
			// have them, so do nothing there but say so.
			$this->framework_available = gutenberg_sync_engines_bundled_gutenberg_is_loaded();

			if ( ! $this->framework_available ) {
				add_action( 'admin_notices', array( $this, 'render_missing_framework_notice' ) );
				return;
			}

			$this->load();
			$this->register();
		}

		/**
		 * Requires the plugin's PHP classes.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		private function load(): void {
			// The server contracts and registries. Gutenberg used to
			// provide these (the functions file is loaded by the plugin
			// entry, ahead of activation).
			$server = GUTENBERG_SYNC_ENGINES_PATH . 'includes/server/';
			require_once $server . 'interface-wp-rtc-storage.php';
			require_once $server . 'class-wp-rtc-post-meta-storage.php';
			require_once $server . 'class-wp-rtc-config.php';
			require_once $server . 'interface-wp-sync-engine.php';
			require_once $server . 'class-wp-sync-engine-registry.php';
			require_once $server . 'interface-wp-sync-transport.php';
			require_once $server . 'class-wp-sync-transport-registry.php';

			// Room storage over the plugin's own tables (the schema class is
			// loaded by the plugin entry, ahead of activation).
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/storage/class-wp-sync-table-storage.php';

			// Shared concurrency primitives (Core-style lock + optimistic
			// CAS), each with a filterable drop-in backend seam.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-lock-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-cas-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-room-lock.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-atomic-option.php';

			// Awareness and the tab list, behind the same kind of drop-in seam as the lock.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-awareness-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-awareness.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-presence-api-awareness-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/interface-wp-sync-tab-list-backend.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-wp-sync-presence-api-tab-list-backend.php';

			// Code the base provides to more than one engine.
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/class-wp-sync-block-identity.php';
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/class-wp-sync-post-genesis-props.php';

			$engines = GUTENBERG_SYNC_ENGINES_PATH . 'includes/engines/';
			require_once $engines . 'intent-log/class-wp-intent-log-document.php';
			require_once $engines . 'intent-log/class-wp-intent-log-planner.php';
			require_once $engines . 'intent-log/class-wp-intent-log-rich-text.php';
			require_once $engines . 'intent-log/class-wp-intent-log-engine.php';
			require_once $engines . 'intent-log/class-wp-intent-log-base-seq-preflight.php';

			$transports = GUTENBERG_SYNC_ENGINES_PATH . 'includes/transports/';
			require_once $transports . 'class-wp-sync-connection.php';
			require_once $transports . 'class-wp-rtc-http-polling-sync-server.php';
			require_once $transports . 'websocket/class-wp-websocket-access-token.php';
			require_once $transports . 'websocket/class-wp-websocket-token-controller.php';
			require_once $transports . 'websocket/class-wp-websocket-connection.php';
			require_once $transports . 'websocket/class-wp-websocket-sync-server.php';
			require_once $transports . 'websocket/class-wp-websocket-sync-transport.php';
			if ( defined( 'WP_CLI' ) && WP_CLI ) {
				require_once $transports . 'websocket/class-wp-sync-server-cli-command.php';
			}
			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/class-gutenberg-sync-engines-advisory-presence.php';

			/*
			 * Diagnostics are development tools, deliberately kept OUT of the
			 * production path: these files only load on local/development
			 * sites (wp-env reports 'local'), or when a site opts in
			 * explicitly by defining the GUTENBERG_SYNC_ENGINES_DIAGNOSTICS
			 * constant. The room CLI is WP-CLI-only; session capture and the
			 * per-request benchmark log hook web requests too (both are
			 * no-ops until a capture session is started / a request carries
			 * the X-RTC-Test tag).
			 */
			$diagnostics_allowed = in_array( wp_get_environment_type(), array( 'local', 'development' ), true )
				|| ( defined( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS' ) && GUTENBERG_SYNC_ENGINES_DIAGNOSTICS );
			if ( $diagnostics_allowed ) {
				$diagnostics = GUTENBERG_SYNC_ENGINES_PATH . 'includes/diagnostics/';
				require_once $diagnostics . 'class-gutenberg-sync-engines-request-log.php';
				require_once $diagnostics . 'class-gutenberg-sync-engines-session-capture.php';
				( new Gutenberg_Sync_Engines_Request_Log() )->register();
				( new Gutenberg_Sync_Engines_Session_Capture() )->register();
				if ( defined( 'WP_CLI' ) && WP_CLI ) {
					require_once $diagnostics . 'class-gutenberg-sync-engines-rooms-cli-command.php';
					require_once $diagnostics . 'class-gutenberg-sync-engines-capture-cli-command.php';
					require_once $diagnostics . 'class-gutenberg-sync-engines-bench-log-cli-command.php';
				}
			}

			require_once GUTENBERG_SYNC_ENGINES_PATH . 'includes/admin/class-gutenberg-sync-engines-settings.php';
		}

		/**
		 * Registers the server hooks, the engine and the transports, and
		 * wires the admin settings screen.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		private function register(): void {
			// The on/off switch. A Gutenberg with this filter follows the
			// plugin's setting. The bundled one follows its experiment,
			// which is kept in step whenever the setting is saved.
			add_filter( 'wp_is_collaboration_enabled', 'wp_rtc_filter_collaboration_enabled' );
			add_action( 'add_option_wp_rtc_enabled', 'wp_rtc_sync_collaboration_experiment' );
			add_action( 'update_option_wp_rtc_enabled', 'wp_rtc_sync_collaboration_experiment' );

			// What Gutenberg used to do for the server side.
			add_action( 'init', 'wp_rtc_register_storage_post_type' );
			add_action( 'rest_api_init', 'wp_rtc_register_rest_routes' );
			add_action( 'admin_init', 'wp_rtc_print_client_settings' );

			add_filter( 'wp_sync_awareness_backend', array( $this, 'filter_awareness_backend' ) );
			add_filter( 'wp_sync_tab_list_backend', array( $this, 'filter_tab_list_backend' ) );
			add_filter( 'wp_sync_engines', array( $this, 'register_engines' ), 10, 2 );
			WP_Intent_Log_Base_Seq_Preflight::register();
			add_filter( 'wp_sync_transports', array( $this, 'register_transports' ), 10, 3 );
			add_filter( 'wp_sync_transport_client_config', array( $this, 'filter_transport_client_config' ), 10, 2 );
			add_action( 'enqueue_block_editor_assets', array( $this, 'enqueue_editor_assets' ) );
			( new Gutenberg_Sync_Engines_Advisory_Presence() )->register();

			( new Gutenberg_Sync_Engines_Settings() )->register();
		}

		/**
		 * Hands awareness to the Presence API plugin when that plugin is
		 * active and recording, replacing only the default the way storage
		 * does, so another plugin's backend is respected.
		 *
		 * @since 0.0.2
		 *
		 * @param WP_Sync_Awareness_Backend|null $backend The backend so far.
		 * @return WP_Sync_Awareness_Backend|null Backend to use.
		 */
		public function filter_awareness_backend( $backend ) {
			if ( null === $backend && WP_Sync_Presence_API_Awareness_Backend::is_available() ) {
				return new WP_Sync_Presence_API_Awareness_Backend();
			}
			return $backend;
		}

		/**
		 * Hands the tab list to the Presence API when it is available.
		 *
		 * @since n.e.x.t
		 *
		 * @param WP_Sync_Tab_List_Backend|null $backend The backend so far.
		 * @return WP_Sync_Tab_List_Backend|null Backend to use.
		 */
		public function filter_tab_list_backend( $backend ) {
			if ( null === $backend && WP_Sync_Presence_API_Tab_List_Backend::is_available() ) {
				return new WP_Sync_Presence_API_Tab_List_Backend();
			}
			return $backend;
		}

		/**
		 * Adds this plugin's engines to the framework's engine registry.
		 *
		 * @since 0.1.0
		 *
		 * @param WP_Sync_Engine[] $engines Engines to register.
		 * @param WP_RTC_Storage   $storage Storage backend.
		 * @return WP_Sync_Engine[] Engines including this plugin's.
		 */
		public function register_engines( array $engines, WP_RTC_Storage $storage ): array {
			// The framework's conventional default is intent-log
			// (WP_Sync_Engine_Registry::DEFAULT_ENGINE), used when the
			// wp_sync_engine option is unset. Registration order only
			// matters as the fallback when a CONFIGURED slug is not
			// registered (misconfiguration degrades to the first engine).
			$engines[] = new WP_Intent_Log_Engine( $storage );
			return $engines;
		}

		/**
		 * Adds this plugin's transports to the framework's transport registry.
		 *
		 * @since 0.1.0
		 *
		 * @param WP_Sync_Transport[]     $transports Transports to register.
		 * @param WP_RTC_Storage          $storage    Storage backend.
		 * @param WP_Sync_Engine_Registry $engines    Engine registry.
		 * @return WP_Sync_Transport[] Transports including this plugin's.
		 */
		public function register_transports( array $transports, WP_RTC_Storage $storage, WP_Sync_Engine_Registry $engines ): array {
			$transports[] = new WP_RTC_HTTP_Polling_Sync_Server( $storage, $engines );
			$transports[] = new WP_WebSocket_Sync_Transport( $storage, $engines );
			return $transports;
		}

		/**
		 * Supplies transport-specific client connection metadata for the
		 * framework's collaboration announcement
		 * (`window._wpCollaborationTransportConfig`): the framework carries no
		 * transport-specific knowledge, so the WebSocket transport's socket
		 * URL must be announced from here. Without it the client's socket
		 * provider has no URL to connect to and the websocket transport
		 * cannot establish a session.
		 *
		 * @since 0.1.0
		 *
		 * @param array    $config     Client config keyed by transport slug.
		 * @param string[] $transports Announced transport slugs.
		 * @return array Config including the socket URL when announced.
		 */
		public function filter_transport_client_config( $config, $transports ): array {
			$config = is_array( $config ) ? $config : array();
			if ( in_array( WP_WebSocket_Sync_Transport::TRANSPORT_SLUG, (array) $transports, true ) ) {
				$config[ WP_WebSocket_Sync_Transport::TRANSPORT_SLUG ] = array(
					'url' => WP_WebSocket_Sync_Transport::get_socket_url(),
				);
			}
			return $config;
		}

		/**
		 * Enqueues the client engine/transport bundle in the editor when
		 * collaboration is enabled, plus the intent-log block-identity stamper
		 * when intent-log is the active engine.
		 *
		 * The bundle registers this plugin's engine adapters and transport
		 * providers with the framework (`wp.sync`) at load time, so the client
		 * can supply whichever engine the server announces. Without it the
		 * framework has no engines or transports and RTC stays disabled.
		 *
		 * The stamper fills `metadata.syncId` for blocks that lack one and
		 * re-mints duplicates directly in the editor store, making block
		 * identity durable. It is a raw script (no build), specific to the
		 * intent-log engine.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function enqueue_editor_assets(): void {
			if ( ! wp_rtc_is_collaboration_enabled() ) {
				return;
			}

			$bundle = GUTENBERG_SYNC_ENGINES_PATH . 'build/sync-engines.js';
			$asset  = GUTENBERG_SYNC_ENGINES_PATH . 'build/sync-engines.asset.php';
			if ( file_exists( $bundle ) && file_exists( $asset ) ) {
				$meta = require $asset;

				/*
				 * Plugin-owned client settings (the framework announcement
				 * stays untouched): the short-polling interval and the
				 * slow awareness mode, both stored in seconds and passed
				 * in milliseconds for the client's timers.
				 */
				$polling_interval   = 0;
				$awareness_interval = 0;
				$awareness_channel  = 'sync';
				if ( class_exists( 'Gutenberg_Sync_Engines_Settings' ) ) {
					$polling_interval   = Gutenberg_Sync_Engines_Settings::polling_interval();
					$awareness_interval = Gutenberg_Sync_Engines_Settings::awareness_interval();
					$awareness_channel  = Gutenberg_Sync_Engines_Settings::awareness_channel();
				}

				// Slow awareness over Heartbeat rides the advisory channel's
				// discovery probe and needs wp.heartbeat on the page.
				$dependencies = isset( $meta['dependencies'] ) ? $meta['dependencies'] : array();
				if ( $awareness_interval > 0 && 'heartbeat' === $awareness_channel ) {
					$dependencies[] = 'heartbeat';
				}

				wp_enqueue_script(
					'gutenberg-sync-engines',
					GUTENBERG_SYNC_ENGINES_URL . 'build/sync-engines.js',
					$dependencies,
					isset( $meta['version'] ) ? $meta['version'] : GUTENBERG_SYNC_ENGINES_VERSION,
					true
				);

				// The conflict review dialogs' stylesheet (the in-canvas
				// cards carry their own styles inline).
				$style = GUTENBERG_SYNC_ENGINES_PATH . 'build/style-sync-engines.css';
				if ( file_exists( $style ) ) {
					wp_enqueue_style(
						'gutenberg-sync-engines',
						GUTENBERG_SYNC_ENGINES_URL . 'build/style-sync-engines.css',
						array( 'wp-components' ),
						isset( $meta['version'] ) ? $meta['version'] : GUTENBERG_SYNC_ENGINES_VERSION
					);
				}

				$settings = array(
					'httpPollingIntervalMs' => max( 0, min( 25, $polling_interval ) ) * 1000,
					'awarenessIntervalMs'   => $awareness_interval * 1000,
					'awarenessChannel'      => $awareness_channel,
				);

				/*
				 * Whether the user may approve markup held for
				 * unfiltered-HTML review. This only decides what the review
				 * UI shows: the server checks the authoring user's capability
				 * again on every write. The framework prints the same flag
				 * as a global of its own. The plugin reads this one so the
				 * UI outlives the framework's globals.
				 */
				$settings['canUnfilteredHtml'] = current_user_can( 'unfiltered_html' );

				/*
				 * The advisory channel's per-tab settings: this tab's
				 * presence token (stamped now, so a joiner is visible to the
				 * first tab's next heartbeat), whether anyone else is already
				 * there, and the WebRTC configuration. Only on a single-post
				 * editor screen; other block-editor screens (widgets, site
				 * editor) have no per-post room to discover peers in, and
				 * keep the always-on polling cadence.
				 */
				$post = get_post();
				if ( $post instanceof WP_Post ) {
					$advisory = ( new Gutenberg_Sync_Engines_Advisory_Presence() )->editor_settings( $post );
					if ( null !== $advisory ) {
						$settings['advisory'] = $advisory;
					}
				}

				wp_add_inline_script(
					'gutenberg-sync-engines',
					'window._gutenbergSyncEnginesSettings = ' . wp_json_encode( $settings ) . ';',
					'before'
				);
			}

			$storage = gutenberg_sync_engines_storage();
			$engines = new WP_Sync_Engine_Registry( $storage );
			// The editor-side identity stamper serves every engine whose
			// blocks carry `metadata.syncId`: intent-log.
			if ( 'intent-log' !== $engines->get_engine_slug_for_room( '' ) ) {
				return;
			}
			$stamper = GUTENBERG_SYNC_ENGINES_PATH . 'includes/shared/sync-id.js';
			wp_enqueue_script(
				'gutenberg-sync-engines-block-identity-stamper',
				GUTENBERG_SYNC_ENGINES_URL . 'includes/shared/sync-id.js',
				array( 'wp-data' ),
				file_exists( $stamper ) ? (string) filemtime( $stamper ) : GUTENBERG_SYNC_ENGINES_VERSION,
				true
			);
		}

		/**
		 * Admin notice shown when the plugin is dormant because a Gutenberg
		 * other than the bundled copy is running.
		 *
		 * @since 0.1.0
		 *
		 * @return void
		 */
		public function render_missing_framework_notice(): void {
			if ( ! current_user_can( 'activate_plugins' ) ) {
				return;
			}

			echo '<div class="notice notice-warning"><p>';
			echo esc_html__( 'WP Real-Time Collaboration is inactive, because another copy of the Gutenberg plugin is active. For now it only works with the Gutenberg it bundles. Deactivate the Gutenberg plugin to use real-time collaboration.', 'gutenberg-sync-engines' );
			echo '</p></div>';
		}

		/**
		 * Admin notice shown when the storage tables could not be created:
		 * collaboration keeps working on the framework's post-meta storage
		 * until they can be.
		 *
		 * @since 0.0.1
		 *
		 * @return void
		 */
		public function render_storage_unavailable_notice(): void {
			if ( ! current_user_can( 'activate_plugins' ) ) {
				return;
			}
			echo '<div class="notice notice-error"><p>';
			echo esc_html__( 'Gutenberg Sync Engines could not create its collaboration storage tables (the database user may lack the CREATE TABLE privilege). Real-time collaboration is running on the slower post-meta storage until they exist; run "wp collaboration storage install" once the privilege is granted.', 'gutenberg-sync-engines' );
			echo '</p></div>';
		}
	}
}
