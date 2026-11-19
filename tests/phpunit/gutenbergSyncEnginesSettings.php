<?php
/**
 * Tests for the Settings → Collaboration screen's model: the "Transport"
 * list that stands for a (transport, advisory channel) pair and stores
 * nothing itself, the WebSocket server URLs, and the polling interval's
 * default.
 *
 * @package gutenberg-sync-engines
 *
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesSettings extends WP_UnitTestCase {
	public function tear_down() {
		foreach (
			array(
				Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION,
				Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION,
				Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD,
				Gutenberg_Sync_Engines_Settings::WEBSOCKET_URL_OPTION,
				Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION,
				Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION,
				Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION,
				Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION,
			) as $option
		) {
			delete_option( $option );
		}
		parent::tear_down();
	}

	public function test_the_transport_list_reads_the_stored_pair() {
		$cases = array(
			array( 'http-polling', '', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING ),
			array( 'http-polling', 'webrtc-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC ),
			array( 'http-polling', 'web-rtc', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC ),
			array( 'http-polling', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBSOCKET ),
			// A preferred transport maps to its entry whatever fallback
			// channel is stored.
			array( 'websocket', '', Gutenberg_Sync_Engines_Settings::DELIVERY_WEBSOCKET ),
			// The retired long-polling transport and the removed SSE
			// transport both read as polling, with the stored channel.
			// (They read as the SSE entry before SSE was removed.)
			array( 'http-long-polling', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBSOCKET ),
			array( 'sse', 'websocket-advisory', Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBSOCKET ),
		);
		foreach ( $cases as list( $transport, $advisory, $expected ) ) {
			update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, $transport );
			update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, $advisory );
			$this->assertSame( $expected, Gutenberg_Sync_Engines_Settings::delivery(), "$transport + $advisory" );
		}

		// Nothing stored: the list shows what the site really uses. The
		// plugin's own default is WebSocket with polling as its backup,
		// and the tests site sets polling with a constant.
		delete_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION );
		delete_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION );
		$this->assertSame( 'websocket', Gutenberg_Sync_Engines_Settings::TRANSPORT_DEFAULT );
		$this->assertSame( 'http-polling', WP_COLLABORATION_TRANSPORT );
		$this->assertSame( 'http-polling', wp_rtc_get_default_transport_slug() );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::DELIVERY_POLLING_WEBRTC, Gutenberg_Sync_Engines_Settings::delivery() );
	}

	public function test_saving_the_transport_list_writes_the_pair_and_stores_nothing_itself() {
		$settings = new Gutenberg_Sync_Engines_Settings();

		$this->assertSame( 'polling-websocket', $settings->sanitize_delivery( 'polling-websocket' ) );
		$this->assertSame( 'http-polling', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'websocket-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// WebSocket keeps WebRTC as the fallback channel.
		$settings->sanitize_delivery( 'websocket' );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'webrtc-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		$settings->sanitize_delivery( 'polling' );
		$this->assertSame( 'http-polling', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( '', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// An unknown value falls back to the default pair.
		$this->assertSame( 'websocket', $settings->sanitize_delivery( 'carrier-pigeon' ) );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
		$this->assertSame( 'webrtc-advisory', get_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION ) );

		// The field's own name is never stored: the plugin short-circuits
		// its update (the sanitize callback has already written the pair).
		$this->assertNotFalse( has_filter( 'pre_update_option_' . Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD ) );
		update_option( Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD, 'websocket' );
		$this->assertFalse( get_option( Gutenberg_Sync_Engines_Settings::DELIVERY_FIELD ) );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );

		// The two options stay scriptable on their own (WP-CLI, the e2e
		// specs): writing one never touches the other.
		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_OPTION, 'websocket-advisory' );
		$this->assertSame( 'websocket', get_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION ) );
	}

	/**
	 * The retired long-polling choice used to become SSE. SSE was removed
	 * from this plugin, so it becomes polling, and so does a stored SSE
	 * choice.
	 */
	public function test_a_stored_long_polling_or_sse_choice_becomes_polling() {
		$settings = new Gutenberg_Sync_Engines_Settings();
		update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, 'http-long-polling' );
		$this->assertSame( 'http-polling', Gutenberg_Sync_Engines_Settings::stored_transport() );
		$this->assertSame( 'http-polling', wp_rtc_get_transport_registry()->get_active_slug() );
		$this->assertSame( 'http-polling', $settings->sanitize_transport( 'http-long-polling' ) );

		foreach ( array( 'sse', 'sse-daemon' ) as $removed ) {
			update_option( Gutenberg_Sync_Engines_Settings::TRANSPORT_OPTION, $removed );
			$this->assertSame( 'http-polling', wp_rtc_get_transport_registry()->get_active_slug(), $removed );
			$this->assertSame( 'http-polling', $settings->sanitize_transport( $removed ), $removed );
		}
	}

	public function test_the_advisory_server_url_falls_back_to_the_transport_server() {
		$this->assertSame( WP_WebSocket_Sync_Transport::get_socket_url(), Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );

		update_option( Gutenberg_Sync_Engines_Settings::WEBSOCKET_URL_OPTION, 'wss://daemon.example.com' );
		$this->assertSame( 'wss://daemon.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );

		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION, 'wss://relay.example.com' );
		$this->assertSame( 'wss://relay.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url() );
		$this->assertSame( 'wss://daemon.example.com', WP_WebSocket_Sync_Transport::get_socket_url(), 'The transport keeps its own server' );

		update_option( Gutenberg_Sync_Engines_Settings::ADVISORY_WEBSOCKET_URL_OPTION, 'https://not-a-socket.example.com' );
		$this->assertSame( 'wss://daemon.example.com', Gutenberg_Sync_Engines_Settings::advisory_websocket_url(), 'A bad scheme means the default' );
	}

	/**
	 * WebSocket is the default transport, and most sites run no daemon.
	 * The browser is only given a socket address when the site says where
	 * its daemon is. Without one it does not try the socket.
	 */
	public function test_the_browser_gets_a_socket_address_only_when_one_is_set() {
		$plugin     = Gutenberg_Sync_Engines_Plugin::instance();
		$transports = array( 'websocket', 'http-polling' );

		// The tests site defines the host constant, which counts.
		$this->assertTrue( defined( 'WP_SYNC_WEBSOCKET_HOST' ) );
		$this->assertTrue( WP_WebSocket_Sync_Transport::has_socket_address() );
		$this->assertSame(
			WP_WebSocket_Sync_Transport::get_socket_url(),
			$plugin->filter_transport_client_config( array(), $transports )['websocket']['url']
		);

		update_option( Gutenberg_Sync_Engines_Settings::WEBSOCKET_URL_OPTION, 'wss://daemon.example.com' );
		$this->assertTrue( WP_WebSocket_Sync_Transport::has_socket_address() );
		$this->assertSame( 'wss://daemon.example.com', $plugin->filter_transport_client_config( array(), $transports )['websocket']['url'] );
	}

	public function test_the_polling_interval_defaults_to_five_seconds() {
		$this->assertSame( 5, Gutenberg_Sync_Engines_Settings::polling_interval() );

		// 0, the first release's "built-in cadence", now means the default.
		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 0 );
		$this->assertSame( 5, Gutenberg_Sync_Engines_Settings::polling_interval() );

		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 3 );
		$this->assertSame( 3, Gutenberg_Sync_Engines_Settings::polling_interval() );

		update_option( Gutenberg_Sync_Engines_Settings::POLLING_INTERVAL_OPTION, 99 );
		$this->assertSame( 25, Gutenberg_Sync_Engines_Settings::polling_interval(), 'Capped below the awareness timeout' );
	}

	public function test_the_awareness_settings_are_off_by_default_and_clamped() {
		$settings = new Gutenberg_Sync_Engines_Settings();

		$this->assertSame( 0, Gutenberg_Sync_Engines_Settings::awareness_interval() );
		$this->assertSame( 'sync', Gutenberg_Sync_Engines_Settings::awareness_channel() );

		$this->assertSame( 0, $settings->sanitize_awareness_interval( -3 ) );
		$this->assertSame( 5, $settings->sanitize_awareness_interval( '5' ) );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_MAX, $settings->sanitize_awareness_interval( 9999 ) );

		$this->assertSame( 'heartbeat', $settings->sanitize_awareness_channel( 'heartbeat' ) );
		$this->assertSame( 'sync', $settings->sanitize_awareness_channel( 'sync' ) );
		$this->assertSame( 'sync', $settings->sanitize_awareness_channel( 'carrier-pigeon' ) );

		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, 15 );
		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION, 'heartbeat' );
		$this->assertSame( 15, Gutenberg_Sync_Engines_Settings::awareness_interval() );
		$this->assertSame( 'heartbeat', Gutenberg_Sync_Engines_Settings::awareness_channel() );

		// A stored value past the cap reads as the cap.
		update_option( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, 9999 );
		$this->assertSame( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_MAX, Gutenberg_Sync_Engines_Settings::awareness_interval() );
	}

	public function test_the_awareness_settings_are_exposed_to_the_rest_api() {
		( new Gutenberg_Sync_Engines_Settings() )->register_options();
		$registered = get_registered_settings();
		foreach ( array( Gutenberg_Sync_Engines_Settings::AWARENESS_INTERVAL_OPTION, Gutenberg_Sync_Engines_Settings::AWARENESS_CHANNEL_OPTION ) as $option ) {
			$this->assertArrayHasKey( $option, $registered );
			$this->assertTrue( $registered[ $option ]['show_in_rest'] );
		}
	}
}
