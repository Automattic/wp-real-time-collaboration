<?php
/**
 * Plugin Name: Gutenberg
 * Description: E2E stand-in for a standalone Gutenberg install. The tests environment mounts this directory at wp-content/plugins/gutenberg, so activating it reproduces a site where Gutenberg was already installed before this plugin. Inactive except during the standalone-gutenberg-precedence spec.
 * Version: 0.0.0-stub
 * Author: WP Real-Time Collaboration e2e fixtures
 * License: GPL-2.0-or-later
 *
 * @package WPRealTimeCollaboration
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'GUTENBERG_STANDALONE_STUB', true );

/**
 * Same top-level symbol the real gutenberg.php declares, DELIBERATELY not
 * guarded by function_exists: if this plugin wrongly loads its
 * bundled Gutenberg while this standalone copy is active, loading this file
 * is the same fatal redeclare a real standalone Gutenberg would hit — which
 * fails the precedence spec loudly instead of silently passing.
 *
 * @since 0.0.0
 *
 * @return void
 */
function gutenberg_pre_init() {}

add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'wp-rtc-test/v1',
			'/gutenberg-status',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => static function () {
					$pre_init = new ReflectionFunction( 'gutenberg_pre_init' );
					return array(
						// Which file supplied Gutenberg's entry symbol: this
						// stub (wp-content/plugins/gutenberg/gutenberg.php)
						// or this plugin's bundled copy.
						'pre_init_file'       => $pre_init->getFileName(),
						'is_stub'             => defined( 'GUTENBERG_STANDALONE_STUB' ),
						'sync_engines_loaded' => function_exists( 'wp_rtc_bootstrap' ),
					);
				},
			)
		);
	}
);
