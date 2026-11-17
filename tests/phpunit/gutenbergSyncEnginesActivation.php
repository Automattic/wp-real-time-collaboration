<?php
/**
 * Tests for the plugin activation hook: activating the plugin switches
 * real-time collaboration on through the plugin's own setting.
 *
 * @package Gutenberg
 */

/**
 * @group collaboration
 */
class Tests_Collaboration_GutenbergSyncEnginesActivation extends WP_UnitTestCase {
	const EXPERIMENTS = 'gutenberg-experiments';

	/**
	 * The plugin entry registers the activation callback on its own file.
	 */
	public function test_activation_hook_is_registered() {
		$this->assertSame(
			10,
			has_action( 'activate_' . plugin_basename( GUTENBERG_SYNC_ENGINES_FILE ), 'gutenberg_sync_engines_activate' )
		);
	}

	/**
	 * A site that had collaboration switched off ends up with it on.
	 */
	public function test_activation_turns_collaboration_on() {
		update_option( 'wp_rtc_enabled', false );
		$this->assertFalse( wp_is_collaboration_enabled() );

		gutenberg_sync_engines_activate( false );

		$this->assertTrue( wp_rtc_is_enabled_setting() );
		$this->assertTrue( wp_is_collaboration_enabled() );
	}

	/**
	 * Gutenberg's experiments belong to Gutenberg. Activation does not
	 * write them, and collaboration is on without its experiment.
	 */
	public function test_activation_leaves_the_gutenberg_experiments_alone() {
		$experiments = array( 'gutenberg-something-else' => true );
		update_option( self::EXPERIMENTS, $experiments );

		gutenberg_sync_engines_activate( false );

		$this->assertSame( $experiments, get_option( self::EXPERIMENTS ) );
		$this->assertTrue( wp_is_collaboration_enabled() );
	}
}
