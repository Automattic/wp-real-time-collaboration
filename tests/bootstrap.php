<?php
/**
 * PHPUnit bootstrap.
 *
 * The plugin owns the whole server side of collaborative editing (see
 * `includes/server/`). Gutenberg supplies the on/off switch
 * (`wp_is_collaboration_enabled()`, which the plugin answers through a
 * filter) and the editor. Both are required in on `muplugins_loaded`
 * below, Gutenberg first, the same order as on a real site. The tests use
 * the bundled copy at `gutenberg/gutenberg.php`.
 *
 * Collaboration is on for the whole suite without any setup: the plugin's
 * `wp_rtc_enabled` setting is on until someone switches it off.
 *
 * @package GutenbergSyncEngines
 */

$gse_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $gse_tests_dir ) {
	$gse_tests_dir = getenv( 'WP_PHPUNIT__DIR' );
}
if ( ! $gse_tests_dir ) {
	$gse_tests_dir = '/wordpress-phpunit';
}

require_once $gse_tests_dir . '/includes/functions.php';

// The diagnostics module (request log, session capture) is environment-gated
// in the plugin bootstrap; force it on so its tests behave the same whether
// or not the test environment reports 'local'.
if ( ! defined( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS' ) ) {
	define( 'GUTENBERG_SYNC_ENGINES_DIAGNOSTICS', true );
}

tests_add_filter(
	'muplugins_loaded',
	static function () {
		// The bundled Gutenberg. The plugin entry would load it too, and
		// requiring it here first keeps the order plain.
		$gutenberg = dirname( __DIR__ ) . '/gutenberg/gutenberg.php';
		if ( file_exists( $gutenberg ) ) {
			require $gutenberg;
		}

		require dirname( __DIR__ ) . '/wp-real-time-collaboration.php';
	}
);

/*
 * The plugin's storage tables. Activation hooks never fire under PHPUnit,
 * and the WP test installer only recreates WordPress's own tables, so the
 * plugin's tables persist across runs while the options table (with the
 * recorded schema version) does not. The plugin's own upgrade path
 * recreates them on `plugins_loaded`; this runs after it and EMPTIES them,
 * so a row that escaped a previous run's transaction rollback cannot leak
 * into this one (post ids restart at 1 every run, so stale rooms would
 * collide). Outside any test transaction — dbDelta's DDL would commit one.
 */
tests_add_filter(
	'plugins_loaded',
	static function () {
		/*
		 * The test fixtures load here, after the plugin has booted on this
		 * same hook: the fixture engine implements the plugin's own
		 * WP_Sync_Engine interface, which does not exist before that.
		 */
		// Test fixture engine (naive opaque relay) used by the transport and
		// registry machinery tests; registered per-test, never in production.
		require __DIR__ . '/phpunit/fixtures/class-test-opaque-relay-engine.php';
		// Test fixture marker for tests that prove a defect not yet fixed.
		require __DIR__ . '/phpunit/fixtures/trait-known-defect-assertions.php';

		if ( ! WP_Sync_Table_Schema::install() ) {
			fwrite( STDERR, "Could not create the plugin's storage tables.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
			exit( 1 );
		}
		WP_Sync_Table_Schema::delete_all_rows();
	},
	20
);

require $gse_tests_dir . '/includes/bootstrap.php';
