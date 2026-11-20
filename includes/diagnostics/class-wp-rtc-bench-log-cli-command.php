<?php
/**
 * WP_RTC_Bench_Log_CLI_Command class
 *
 * @package WPRealTimeCollaboration
 */

if ( ! class_exists( 'WP_RTC_Bench_Log_CLI_Command' ) && defined( 'WP_CLI' ) && WP_CLI ) {

	/**
	 * Reads and manages the per-request benchmark log (see
	 * WP_RTC_Request_Log): the community-harness-convention
	 * server-side metrics recorded for tagged /wp-rtc/ requests.
	 *
	 * A development tool, loaded only where diagnostics are allowed — see
	 * WP_RTC_Plugin::load().
	 *
	 * @since 0.4.0
	 */
	final class WP_RTC_Bench_Log_CLI_Command {

		/**
		 * Prints the aggregate report (the community harness's table
		 * layout: per scenario × poll-delay × update-size, with a ratio to
		 * the `baseline` scenario).
		 *
		 * ## OPTIONS
		 *
		 * [--all]
		 * : Group per approach label (engine/transport) first, like the
		 * community harness's report-all.
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration bench-log report
		 *     wp collaboration bench-log report --all
		 *
		 * @since 0.4.0
		 *
		 * @param array $args       Positional arguments (unused).
		 * @param array $assoc_args Named arguments.
		 * @return void
		 */
		public function report( $args, $assoc_args ) { // phpcs:ignore VariableAnalysis.CodeAnalysis.VariableAnalysis.UnusedVariable -- $args is part of the WP-CLI command signature.
			$text = WP_RTC_Request_Log::report_text( null, isset( $assoc_args['all'] ) );
			if ( '' === $text ) {
				WP_CLI::log( 'The benchmark log is empty. Tagged requests (X-RTC-Test: 1) populate it.' );
				return;
			}
			WP_CLI::line( $text );
		}

		/**
		 * Clears the benchmark log rows (table intact).
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration bench-log clear
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public function clear() {
			global $wpdb;
			WP_RTC_Request_Log::ensure_table();
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared -- Diagnostics-only table.
			$deleted = (int) $wpdb->query( 'DELETE FROM `' . WP_RTC_Request_Log::table() . '`' );
			WP_CLI::success( "Cleared {$deleted} log rows." );
		}

		/**
		 * Prints the environment snapshot (JSON).
		 *
		 * ## EXAMPLES
		 *
		 *     wp collaboration bench-log env
		 *
		 * @since 0.4.0
		 *
		 * @return void
		 */
		public function env() {
			WP_CLI::line( (string) wp_json_encode( WP_RTC_Request_Log::environment(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
		}
	}

	WP_CLI::add_command( 'collaboration bench-log', 'WP_RTC_Bench_Log_CLI_Command' );
}
