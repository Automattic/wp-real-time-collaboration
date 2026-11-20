<?php
/**
 * The server pieces the plugin provides for collaborative editing: the
 * on/off setting, the storage and transport lookups, the REST routes, and
 * the settings printed for the browser.
 *
 * Gutenberg used to provide these. The plugin owns them now, so they work
 * the same beside any Gutenberg version.
 *
 * @package WPRealTimeCollaboration
 */

if ( ! function_exists( 'wp_rtc_is_enabled_setting' ) ) {
	/**
	 * The plugin's own on/off setting for real-time collaboration.
	 *
	 * This is what the site owner chose. Whether collaboration is really
	 * running also depends on Gutenberg, so most code should ask
	 * wp_rtc_is_collaboration_enabled() instead.
	 *
	 * @since n.e.x.t
	 *
	 * @return bool True when the site owner has collaboration switched on.
	 */
	function wp_rtc_is_enabled_setting(): bool {
		return (bool) get_option( 'wp_rtc_enabled', true );
	}
}

if ( ! function_exists( 'wp_rtc_filter_collaboration_enabled' ) ) {
	/**
	 * Answers Gutenberg's `wp_is_collaboration_enabled` filter with the
	 * plugin's own setting.
	 *
	 * Gutenberg turns collaboration on and off from the plugin's setting
	 * alone. Its own real-time collaboration experiment, which is the
	 * filter's starting value, has no say while this plugin is active.
	 *
	 * @since n.e.x.t
	 *
	 * @return bool The plugin's setting.
	 */
	function wp_rtc_filter_collaboration_enabled(): bool {
		return wp_rtc_is_enabled_setting();
	}
}

if ( ! function_exists( 'wp_rtc_is_collaboration_enabled' ) ) {
	/**
	 * Whether real-time collaboration is running on this site.
	 *
	 * Gutenberg decides, because the editor only loads its collaboration
	 * code when Gutenberg says so. Without a Gutenberg that knows about
	 * collaboration, the answer is no.
	 *
	 * @since n.e.x.t
	 *
	 * @return bool True when collaboration is on.
	 */
	function wp_rtc_is_collaboration_enabled(): bool {
		if ( ! function_exists( 'wp_is_collaboration_enabled' ) ) {
			return false;
		}

		return (bool) wp_is_collaboration_enabled();
	}
}

if ( ! function_exists( 'wp_rtc_get_storage' ) ) {
	/**
	 * The storage that holds rooms and their rows.
	 *
	 * The default is the plugin's own tables. A site that could not create
	 * the tables falls back to storing rows as post meta, so collaboration
	 * keeps working there. Every part of the plugin gets its storage here,
	 * so a replacement applies everywhere at once.
	 *
	 * Built new on each call: a storage object keeps per-request caches
	 * that must not outlive a request.
	 *
	 * @since n.e.x.t
	 *
	 * @return WP_RTC_Storage Storage to use.
	 */
	function wp_rtc_get_storage(): WP_RTC_Storage {
		if ( WP_RTC_Table_Schema::is_ready() ) {
			$default = new WP_RTC_Table_Storage();
		} else {
			$default = new WP_RTC_Post_Meta_Storage();
		}

		/**
		 * Filters the storage that holds collaboration rooms.
		 *
		 * Return an object that implements WP_RTC_Storage to use another
		 * backend. The interface documents what a storage must guarantee.
		 * Anything else is ignored.
		 *
		 * @since n.e.x.t
		 *
		 * @param WP_RTC_Storage $storage The default storage.
		 */
		$storage = apply_filters( 'wp_rtc_storage', $default );
		if ( ! $storage instanceof WP_RTC_Storage ) {
			return $default;
		}

		return $storage;
	}
}

if ( ! function_exists( 'wp_rtc_get_default_transport_slug' ) ) {
	/**
	 * The transport a site uses when no choice is stored: the
	 * `WP_COLLABORATION_TRANSPORT` constant, then the environment variable
	 * of the same name, then WebSocket with polling as its backup.
	 *
	 * With WebSocket, a tab polls until its socket opens and whenever the
	 * socket is down, and a site with no sync daemon address set never
	 * tries the socket (see
	 * `WP_WebSocket_Sync_Transport::has_socket_address()`).
	 *
	 * @since n.e.x.t
	 *
	 * @return string Transport slug.
	 */
	function wp_rtc_get_default_transport_slug(): string {
		if ( defined( 'WP_COLLABORATION_TRANSPORT' ) && is_string( WP_COLLABORATION_TRANSPORT ) && '' !== WP_COLLABORATION_TRANSPORT ) {
			return WP_COLLABORATION_TRANSPORT;
		}
		$from_env = getenv( 'WP_COLLABORATION_TRANSPORT' );
		if ( is_string( $from_env ) && '' !== $from_env ) {
			return $from_env;
		}

		return 'websocket';
	}
}

if ( ! function_exists( 'wp_rtc_get_transport_slug' ) ) {
	/**
	 * The slug of the transport the site is configured to use.
	 *
	 * Read from the `WP_COLLABORATION_TRANSPORT` constant, then the
	 * environment variable of the same name, then the
	 * `wp_collaboration_transport` filter, which the settings screen
	 * answers (see `wp_rtc_get_default_transport_slug()` for the
	 * default). A slug that is not registered is replaced by a
	 * registered one in the transport registry.
	 *
	 * @since n.e.x.t
	 *
	 * @return string Configured transport slug.
	 */
	function wp_rtc_get_transport_slug(): string {
		$transport = wp_rtc_get_default_transport_slug();

		/**
		 * Filters the active collaboration transport slug.
		 *
		 * @since 0.1.0
		 *
		 * @param string $transport Transport slug.
		 */
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- A documented filter name that sites already use.
		return (string) apply_filters( 'wp_collaboration_transport', $transport );
	}
}

if ( ! function_exists( 'wp_rtc_get_transport_registry' ) ) {
	/**
	 * Builds a transport registry over the storage and the engine registry.
	 *
	 * Built new on each call, for the same reason as the storage.
	 *
	 * @since n.e.x.t
	 *
	 * @return WP_RTC_Transport_Registry Transport registry.
	 */
	function wp_rtc_get_transport_registry(): WP_RTC_Transport_Registry {
		$storage = wp_rtc_get_storage();
		$engines = new WP_RTC_Engine_Registry( $storage );

		return new WP_RTC_Transport_Registry( $storage, $engines );
	}
}

if ( ! function_exists( 'wp_rtc_register_storage_post_type' ) ) {
	/**
	 * Registers the hidden post type the fallback storage keeps its rows
	 * under. Only a site without the plugin's tables uses it.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function wp_rtc_register_storage_post_type(): void {
		if ( ! wp_rtc_is_collaboration_enabled() ) {
			return;
		}

		register_post_type(
			WP_RTC_Post_Meta_Storage::POST_TYPE,
			array(
				'labels'             => array(
					'name'          => __( 'Sync Updates', 'wp-real-time-collaboration' ),
					'singular_name' => __( 'Sync Update', 'wp-real-time-collaboration' ),
				),
				'public'             => false,
				'hierarchical'       => false,
				'capabilities'       => array(
					'read'                   => 'do_not_allow',
					'read_private_posts'     => 'do_not_allow',
					'create_posts'           => 'do_not_allow',
					'publish_posts'          => 'do_not_allow',
					'edit_posts'             => 'do_not_allow',
					'edit_others_posts'      => 'do_not_allow',
					'edit_published_posts'   => 'do_not_allow',
					'delete_posts'           => 'do_not_allow',
					'delete_others_posts'    => 'do_not_allow',
					'delete_published_posts' => 'do_not_allow',
				),
				'map_meta_cap'       => false,
				'publicly_queryable' => false,
				'query_var'          => false,
				'rewrite'            => false,
				'show_in_menu'       => false,
				'show_in_rest'       => false,
				'show_ui'            => false,
				'supports'           => array( 'custom-fields' ),
			)
		);
	}
}

if ( ! function_exists( 'wp_rtc_register_rest_routes' ) ) {
	/**
	 * Registers the REST routes of every transport. All of them are
	 * reachable. The browser uses the one the server announces as active.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function wp_rtc_register_rest_routes(): void {
		if ( ! wp_rtc_is_collaboration_enabled() ) {
			return;
		}

		wp_rtc_get_transport_registry()->register_all_routes();
	}
}

if ( ! function_exists( 'wp_rtc_print_client_settings' ) ) {
	/**
	 * Prints what the browser needs to join a room: the engine and its
	 * protocol version, the transports in order of preference, and each
	 * transport's connection details.
	 *
	 * The browser refuses to join when it cannot provide the announced
	 * engine or protocol version, or none of the transports. The editor
	 * then falls back to the post lock.
	 *
	 * @since n.e.x.t
	 *
	 * @return void
	 */
	function wp_rtc_print_client_settings(): void {
		if ( ! wp_rtc_is_collaboration_enabled() ) {
			return;
		}

		$transport_registry = wp_rtc_get_transport_registry();
		$engine             = ( new WP_RTC_Engine_Registry( wp_rtc_get_storage() ) )->get_engine_for_room( '' );
		$active_transport   = $transport_registry->get_transport( $transport_registry->get_active_slug() );

		$sync = array(
			'engine'            => '',
			'engineProtocol'    => 0,
			// The active transport comes first. The browser picks the
			// first one it can provide.
			'transports'        => $transport_registry->get_announced_slugs(),
			'transportProtocol' => 1,
		);
		if ( null !== $engine ) {
			$sync['engine']         = $engine->get_slug();
			$sync['engineProtocol'] = $engine->get_protocol_version();
		}

		if ( null !== $active_transport ) {
			$sync['transportProtocol'] = $active_transport->get_protocol_version();
		}

		/**
		 * Filters the connection details the browser gets for each
		 * transport, keyed by transport slug. The WebSocket transport adds
		 * its socket address here.
		 *
		 * @since 0.1.0
		 *
		 * @param array    $config     Connection details by transport slug.
		 * @param string[] $transports Announced transport slugs.
		 */
		$transport_config = (object) apply_filters( 'wp_rtc_transport_client_config', array(), $sync['transports'] );

		wp_add_inline_script(
			'wp-core-data',
			'window._wpCollaborationSync = ' . wp_json_encode( $sync ) . ';' .
			// Shown in the browser only. The server stamps the real user
			// on every edit from the signed-in request.
			'window._wpCollaborationUserId = ' . wp_json_encode( get_current_user_id() ) . ';' .
			'window._wpCollaborationTransportConfig = ' . wp_json_encode( $transport_config ) . ';' .
			// Decides what the review screens show. The server checks the
			// author's capability again on every write.
			'window._wpCollaborationCanUnfilteredHtml = ' . wp_json_encode( current_user_can( 'unfiltered_html' ) ) . ';',
			'after'
		);
	}
}
