<?php
/**
 * Drives this plugin's awareness and the advisory channel's tab list against
 * the REAL Presence API plugin, the other half of a PHPUnit suite that can
 * only use a stand-in.
 *
 * Usage (tests env, which installs and activates the Presence API):
 *   npx wp-env --config .wp-env.tests.json run cli \
 *     --env-cwd=wp-content/plugins/wp-real-time-collaboration \
 *     wp eval-file tests/tools/check-presence-api.php
 *
 * Exits non-zero on the first thing that does not hold.
 *
 * @package WPRealTimeCollaboration
 */

global $wpdb;

$wp_rtc_failures = 0;

/**
 * Prints one result and remembers a failure.
 *
 * @param bool   $ok     Whether the check held.
 * @param string $label  What was checked.
 * @param string $detail Optional context to print alongside.
 */
function wp_rtc_presence_check( $ok, $label, $detail = '' ) {
	global $wp_rtc_failures;

	if ( ! $ok ) {
		++$wp_rtc_failures;
	}

	WP_CLI::log( ( $ok ? '  ok   ' : '  FAIL ' ) . $label . ( '' !== $detail ? " -- {$detail}" : '' ) );
}

if ( ! function_exists( 'wp_set_presence' ) ) {
	WP_CLI::error( 'The Presence API plugin is not active on this site.' );
}
if ( ! class_exists( 'WP_RTC_Awareness' ) ) {
	WP_CLI::error( 'This plugin is not active on this site.' );
}

$wp_rtc_user_id = (int) get_users(
	array(
		'role'   => 'administrator',
		'number' => 1,
		'fields' => 'ID',
	)
)[0];
wp_set_current_user( $wp_rtc_user_id );

$wp_rtc_post_id = wp_insert_post(
	array(
		'post_title'  => 'presence api check',
		'post_status' => 'draft',
	)
);
$wp_rtc_room    = 'postType/post:' . $wp_rtc_post_id;
$wp_rtc_state   = array(
	'name'       => 'Ada',
	'wpRtcBlock' => 'p1',
);

/**
 * One stored presence row, straight from the table.
 *
 * @param string $room      Room identifier.
 * @param string $client_id The row's client id.
 * @return object|null The row, or null when there is none.
 */
function wp_rtc_presence_row( $room, $client_id ) {
	global $wpdb;

	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	return $wpdb->get_row(
		$wpdb->prepare( "SELECT * FROM {$wpdb->presence} WHERE room = %s AND client_id = %s", $room, $client_id )
	);
}

// The seam picks the backend up at all.
wp_rtc_presence_check( WP_RTC_Presence_API_Awareness_Backend::is_available(), 'the backend reports itself available' );
wp_rtc_presence_check( WP_RTC_Awareness::has_substitute_backend(), 'the seam picked the Presence API backend' );

$wp_rtc_awareness = new WP_RTC_Awareness( wp_rtc_get_storage() );

// A write lands in the real table and comes back out of it unchanged.
$wp_rtc_entries = $wp_rtc_awareness->put( $wp_rtc_room, 7, $wp_rtc_state, $wp_rtc_user_id, 30 );
wp_rtc_presence_check( array( 7 ) === array_column( $wp_rtc_entries, 'client_id' ), 'a write returns the room' );
wp_rtc_presence_check( $wp_rtc_state === $wp_rtc_entries[0]['state'], 'state round trips', wp_json_encode( $wp_rtc_entries[0]['state'] ) );
wp_rtc_presence_check( $wp_rtc_user_id === $wp_rtc_entries[0]['wp_user_id'], 'the user id round trips' );
wp_rtc_presence_check( null !== wp_rtc_presence_row( $wp_rtc_room, 'wp-rtc-7' ), 'the row is in wp_presence' );
wp_rtc_presence_check( array() === wp_rtc_get_storage()->get_awareness_state( $wp_rtc_room ), 'the room array stayed empty' );

// One client's write leaves another's row alone.
$wp_rtc_entries = $wp_rtc_awareness->put( $wp_rtc_room, 9, array( 'name' => 'Grace' ), $wp_rtc_user_id, 30 );
wp_rtc_presence_check( array( 7, 9 ) === array_column( $wp_rtc_entries, 'client_id' ), 'two clients coexist' );

// An idle client repeating its state writes nothing.
$wp_rtc_writes = 0;
add_filter(
	'query',
	static function ( $query ) use ( &$wp_rtc_writes ) {
		if ( false !== stripos( $query, 'INSERT INTO' ) && false !== stripos( $query, 'presence' ) ) {
			++$wp_rtc_writes;
		}
		return $query;
	}
);
$wp_rtc_awareness->put( $wp_rtc_room, 7, $wp_rtc_state, $wp_rtc_user_id, 30 );
wp_rtc_presence_check( 0 === $wp_rtc_writes, 'an idle repeat is read-only', "writes={$wp_rtc_writes}" );

// A quiet client past this backend's refresh age IS rewritten, at the oldest
// age the Presence API's own skip would still have left the row alone. Both
// ages are read off the code rather than guessed, and the check below pins
// that the one is in fact past the other.
$wp_rtc_refresh = max( 1, intdiv( 30, WP_RTC_Presence_API_Awareness_Backend::REFRESH_FRACTION ) );
$wp_rtc_skip    = function_exists( 'wp_presence_refresh_threshold' ) ? wp_presence_refresh_threshold() : $wp_rtc_refresh;

wp_rtc_presence_check(
	$wp_rtc_skip >= $wp_rtc_refresh,
	'the Presence API would skip a row this backend refreshes',
	"skip={$wp_rtc_skip}s refresh={$wp_rtc_refresh}s"
);

// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query(
	$wpdb->prepare(
		"UPDATE {$wpdb->presence} SET date_gmt = %s WHERE room = %s AND client_id = %s",
		gmdate( 'Y-m-d H:i:s', time() - $wp_rtc_skip ),
		$wp_rtc_room,
		'wp-rtc-7'
	)
);

$wp_rtc_awareness->put( $wp_rtc_room, 7, $wp_rtc_state, $wp_rtc_user_id, 30 );
$wp_rtc_age = time() - (int) strtotime( wp_rtc_presence_row( $wp_rtc_room, 'wp-rtc-7' )->date_gmt . ' UTC' );
wp_rtc_presence_check( $wp_rtc_age <= 1, 'a quiet client is refreshed anyway', "age={$wp_rtc_age}s" );

// Rows the Presence API keeps for its own screens are not collaborators,
// and a collaborator leaving does not disturb them.
wp_set_presence( $wp_rtc_room, 'editor-' . $wp_rtc_user_id, array(), $wp_rtc_user_id );
wp_rtc_presence_check( array( 7, 9 ) === array_column( $wp_rtc_awareness->entries( $wp_rtc_room, 30 ), 'client_id' ), 'rows without the wp-rtc- prefix are ignored' );

$wp_rtc_entries = $wp_rtc_awareness->forget( $wp_rtc_room, 7, 30 );
wp_rtc_presence_check( array( 9 ) === array_column( $wp_rtc_entries, 'client_id' ), 'leaving removes one client' );
wp_rtc_presence_check( null !== wp_rtc_presence_row( $wp_rtc_room, 'editor-' . $wp_rtc_user_id ), "the Presence API's own row survives" );

$wp_rtc_tab_list = apply_filters( 'wp_rtc_tab_list_backend', null );
wp_rtc_presence_check( $wp_rtc_tab_list instanceof WP_RTC_Presence_API_Tab_List_Backend, 'the seam picked the Presence API tab list' );

$wp_rtc_ttl = WP_RTC_Advisory_Presence::PRESENCE_TTL;
$wp_rtc_tab = array(
	'c' => 'Ada',
	'j' => 1,
);
$wp_rtc_tab_list->put( $wp_rtc_room, 'tok-a', $wp_rtc_tab, $wp_rtc_user_id, $wp_rtc_ttl );
$wp_rtc_tab_list->put( $wp_rtc_room, 'tok-b', array( 'c' => 'Grace' ), $wp_rtc_user_id, $wp_rtc_ttl );
$wp_rtc_tabs = $wp_rtc_tab_list->tabs( $wp_rtc_room, $wp_rtc_ttl );
wp_rtc_presence_check( array( 'tok-a', 'tok-b' ) === array_keys( $wp_rtc_tabs ), 'two tabs coexist', wp_json_encode( array_keys( $wp_rtc_tabs ) ) );
wp_rtc_presence_check( $wp_rtc_tab === $wp_rtc_tabs['tok-a']['state'], 'tab state round trips' );
wp_rtc_presence_check( $wp_rtc_user_id === $wp_rtc_tabs['tok-a']['user_id'], 'the tab user id round trips' );

// The row lives as long as the channel asked, not the site's shorter default.
$wp_rtc_row      = wp_rtc_presence_row( $wp_rtc_room, 'wp-rtctab-tok-a' );
$wp_rtc_lifetime = null === $wp_rtc_row ? 0 : strtotime( $wp_rtc_row->expires_gmt . ' UTC' ) - strtotime( $wp_rtc_row->date_gmt . ' UTC' );
wp_rtc_presence_check( $wp_rtc_ttl === $wp_rtc_lifetime, 'a tab row lasts as long as asked', "lifetime={$wp_rtc_lifetime}s" );

// A refresh the Presence API would skip as too recent is still written.
// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query(
	$wpdb->prepare(
		"UPDATE {$wpdb->presence} SET date_gmt = %s WHERE room = %s AND client_id = %s",
		gmdate( 'Y-m-d H:i:s', time() - 5 ),
		$wp_rtc_room,
		'wp-rtctab-tok-a'
	)
);
$wp_rtc_tab_list->put( $wp_rtc_room, 'tok-a', $wp_rtc_tab, $wp_rtc_user_id, $wp_rtc_ttl );
$wp_rtc_age = time() - (int) strtotime( wp_rtc_presence_row( $wp_rtc_room, 'wp-rtctab-tok-a' )->date_gmt . ' UTC' );
wp_rtc_presence_check( $wp_rtc_age <= 1, 'a tab refresh is always written', "age={$wp_rtc_age}s" );

wp_rtc_presence_check( array( 9 ) === array_column( $wp_rtc_awareness->entries( $wp_rtc_room, 30 ), 'client_id' ), 'awareness ignores tab rows' );
wp_rtc_presence_check( ! isset( $wp_rtc_tabs['9'] ) && 2 === count( $wp_rtc_tabs ), 'the tab list ignores awareness rows' );

$wp_rtc_tab_list->forget( $wp_rtc_room, 'tok-b' );
wp_rtc_presence_check( array( 'tok-a' ) === array_keys( $wp_rtc_tab_list->tabs( $wp_rtc_room, $wp_rtc_ttl ) ), 'leaving removes one tab' );

// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->presence} WHERE room = %s", $wp_rtc_room ) );
wp_delete_post( $wp_rtc_post_id, true );

if ( $wp_rtc_failures > 0 ) {
	WP_CLI::error( $wp_rtc_failures . ' check(s) failed.' );
}

WP_CLI::success( 'Awareness and the tab list work against the real Presence API.' );
