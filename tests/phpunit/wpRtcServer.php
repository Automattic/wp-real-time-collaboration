<?php
/**
 * Tests for the server pieces the plugin owns: the on/off setting, the
 * storage lookup, and the settings printed for the browser
 * (`includes/server/functions.php`).
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_WpRtcServer extends WP_UnitTestCase {
	const EXPERIMENTS = 'gutenberg-experiments';
	const EXPERIMENT  = 'gutenberg-real-time-collaboration';

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
	}

	/**
	 * The inline scripts printed after `wp-core-data` so far.
	 *
	 * @return string Script text.
	 */
	private function core_data_inline_script(): string {
		$after = wp_scripts()->get_data( 'wp-core-data', 'after' );
		if ( ! is_array( $after ) ) {
			return '';
		}

		return implode( "\n", array_filter( $after, 'is_string' ) );
	}

	public function test_the_setting_is_on_until_someone_switches_it_off() {
		delete_option( 'wp_rtc_enabled' );
		$this->assertTrue( wp_rtc_is_enabled_setting() );

		update_option( 'wp_rtc_enabled', false );
		$this->assertFalse( wp_rtc_is_enabled_setting() );

		update_option( 'wp_rtc_enabled', true );
		$this->assertTrue( wp_rtc_is_enabled_setting() );
	}

	public function test_activation_switches_the_setting_on() {
		update_option( 'wp_rtc_enabled', false );

		wp_rtc_activate( false );

		$this->assertTrue( wp_rtc_is_enabled_setting() );
		$this->assertTrue( wp_rtc_is_collaboration_enabled() );
	}

	/**
	 * Gutenberg starts its `wp_is_collaboration_enabled` filter from its
	 * own experiment. The plugin's setting decides, whatever that says.
	 */
	public function test_the_setting_decides_whatever_the_gutenberg_experiment_says() {
		update_option( self::EXPERIMENTS, array( self::EXPERIMENT => true ) );
		update_option( 'wp_rtc_enabled', false );
		$this->assertFalse( wp_rtc_is_collaboration_enabled() );

		update_option( self::EXPERIMENTS, array() );
		update_option( 'wp_rtc_enabled', true );
		$this->assertTrue( wp_rtc_is_collaboration_enabled() );
	}

	/**
	 * Saving the setting writes nothing to Gutenberg's experiments.
	 */
	public function test_saving_the_setting_leaves_the_gutenberg_experiments_alone() {
		$experiments = array( 'gutenberg-something-else' => true );
		update_option( self::EXPERIMENTS, $experiments );

		update_option( 'wp_rtc_enabled', false );
		update_option( 'wp_rtc_enabled', true );

		$this->assertSame( $experiments, get_option( self::EXPERIMENTS ) );
	}

	/**
	 * Gutenberg follows the plugin's setting through this callback on its
	 * `wp_is_collaboration_enabled` filter.
	 */
	public function test_the_gutenberg_filter_answers_with_the_setting() {
		$this->assertSame( 10, has_filter( 'wp_is_collaboration_enabled', 'wp_rtc_filter_collaboration_enabled' ) );

		update_option( 'wp_rtc_enabled', false );
		$this->assertFalse( apply_filters( 'wp_is_collaboration_enabled', true ) );

		update_option( 'wp_rtc_enabled', true );
		$this->assertTrue( apply_filters( 'wp_is_collaboration_enabled', false ) );
	}

	public function test_the_storage_filter_ignores_a_value_that_is_not_a_storage() {
		$junk = static function () {
			return 'not a storage';
		};
		add_filter( 'wp_rtc_storage', $junk );
		$resolved = wp_rtc_get_storage();
		remove_filter( 'wp_rtc_storage', $junk );

		$this->assertInstanceOf( 'WP_RTC_Table_Storage', $resolved );
	}

	public function test_the_browser_is_told_the_engine_and_the_transports() {
		wp_rtc_print_client_settings();
		$script = $this->core_data_inline_script();

		$this->assertStringContainsString(
			'window._wpCollaborationSync = ' . wp_json_encode(
				array(
					'engine'            => 'intent-log',
					'engineProtocol'    => WP_Intent_Log_Engine::PROTOCOL_VERSION,
					'transports'        => array( 'http-polling', 'websocket' ),
					'transportProtocol' => 1,
				)
			) . ';',
			$script
		);
		$this->assertStringContainsString( 'window._wpCollaborationUserId = ' . get_current_user_id() . ';', $script );
		$this->assertStringContainsString( 'window._wpCollaborationTransportConfig = {"websocket":{"url":', $script );
		$this->assertStringContainsString( 'window._wpCollaborationCanUnfilteredHtml = ', $script );
	}

	public function test_the_browser_is_told_nothing_while_collaboration_is_off() {
		$before = $this->core_data_inline_script();
		update_option( 'wp_rtc_enabled', false );

		wp_rtc_print_client_settings();

		$this->assertSame( $before, $this->core_data_inline_script() );
	}

	public function test_the_server_hooks_are_registered() {
		$this->assertSame( 10, has_action( 'init', 'wp_rtc_register_storage_post_type' ) );
		$this->assertSame( 10, has_action( 'rest_api_init', 'wp_rtc_register_rest_routes' ) );
		$this->assertSame( 10, has_action( 'admin_init', 'wp_rtc_print_client_settings' ) );
		$this->assertTrue( post_type_exists( WP_RTC_Post_Meta_Storage::POST_TYPE ) );
	}
}
