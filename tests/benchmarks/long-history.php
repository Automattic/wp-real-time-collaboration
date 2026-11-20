<?php
/**
 * Long-history benchmark: the cost of one request against a room that
 * already holds many stored edits.
 *
 * It runs inside WordPress, against the real table storage, so the cost
 * of reading the stored rows is part of the number:
 *
 *   wp eval-file tests/benchmarks/long-history.php \
 *       history=0,100,250,450,700,950 samples=20 json=out.json
 *
 * Use `npm run bench -- --suite=long-history`, which runs this file in the
 * tests environment and prints a table.
 *
 * For each history size it fills a new room with that many accepted edits,
 * then measures two kinds of request. Each measured request builds a new
 * storage object and a new engine object, as a polling web request does:
 *
 * - commit: one request that carries one typed character.
 * - idle read: one request that carries nothing and asks for rows after
 *   the newest one.
 *
 * The engine saves a full snapshot every 500 accepted edits and trims the
 * rows before the previous snapshot, so the stored history tops out near
 * 1,000 edits. Keep `history + samples` away from a multiple of 500, or a
 * measured commit also pays for a snapshot.
 *
 * @package gutenberg
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "Run this through: wp eval-file long-history.php <options>\n" );
	exit( 1 );
}

/**
 * Parses `key=value` tokens into an options map.
 *
 * @param array $tokens Argument tokens.
 * @return array Options map.
 */
function wp_rtc_bench_long_history_args( array $tokens ): array {
	$options = array();
	foreach ( $tokens as $token ) {
		if ( preg_match( '/^-{0,2}([a-z0-9-]+)=(.*)$/', (string) $token, $matches ) ) {
			$options[ $matches[1] ] = $matches[2];
		}
	}

	return $options;
}

/**
 * The middle value of a list of numbers.
 *
 * @param float[] $values   Samples.
 * @param float   $fraction Position in the sorted list, 0 to 1.
 * @return float The value at that position.
 */
function wp_rtc_bench_long_history_percentile( array $values, float $fraction ): float {
	sort( $values );
	$index = (int) floor( ( count( $values ) - 1 ) * $fraction );

	return round( $values[ $index ], 3 );
}

/**
 * Sends one request's worth of edits through a new engine object.
 *
 * @param string $room      Room name.
 * @param int    $client_id Client id.
 * @param array  $intents   Edits to send.
 * @return array The engine's answer.
 */
function wp_rtc_bench_long_history_commit( string $room, int $client_id, array $intents ): array {
	$updates = array();
	foreach ( $intents as $intent ) {
		$updates[] = array(
			'type' => WP_Intent_Log_Engine::UPDATE_TYPE_INTENT,
			'data' => wp_json_encode( $intent ),
		);
	}

	$engine = new WP_Intent_Log_Engine( new WP_RTC_Table_Storage() );
	$result = $engine->handle_updates( $room, $client_id, 0, $updates, array() );
	if ( is_wp_error( $result ) ) {
		fwrite( STDERR, 'Commit failed: ' . $result->get_error_message() . "\n" );
		exit( 1 );
	}

	foreach ( $result['dispositions'] as $disposition ) {
		if ( 'applied' !== $disposition['status'] ) {
			fwrite( STDERR, 'An edit was not applied: ' . wp_json_encode( $disposition ) . "\n" );
			exit( 1 );
		}
	}

	return $result;
}

$wp_rtc_bench_options = wp_rtc_bench_long_history_args(
	isset( $args ) && is_array( $args ) ? $args : ( $argv ?? array() )
);
$wp_rtc_bench_sizes   = array_map( 'intval', explode( ',', $wp_rtc_bench_options['history'] ?? '0,100,250,450,700,950' ) );
$wp_rtc_bench_samples = max( 1, (int) ( $wp_rtc_bench_options['samples'] ?? 20 ) );
$wp_rtc_bench_json    = $wp_rtc_bench_options['json'] ?? '';

// The engine stamps each edit with the current user, and checks what
// markup that user may publish.
$wp_rtc_bench_admins = get_users(
	array(
		'role'   => 'administrator',
		'number' => 1,
		'fields' => 'ID',
	)
);
wp_set_current_user( (int) ( $wp_rtc_bench_admins[0] ?? 1 ) );

$wp_rtc_bench_paragraphs = 8;
$wp_rtc_bench_content    = array();
for ( $wp_rtc_bench_i = 0; $wp_rtc_bench_i < $wp_rtc_bench_paragraphs; $wp_rtc_bench_i++ ) {
	$wp_rtc_bench_content[] = "<!-- wp:paragraph -->\n<p>Paragraph {$wp_rtc_bench_i};</p>\n<!-- /wp:paragraph -->";
}

$wp_rtc_bench_results = array();
foreach ( $wp_rtc_bench_sizes as $wp_rtc_bench_size ) {
	$wp_rtc_bench_post_id = wp_insert_post(
		array(
			'post_title'   => 'Long history benchmark',
			'post_status'  => 'draft',
			'post_content' => implode( "\n\n", $wp_rtc_bench_content ),
		)
	);
	$wp_rtc_bench_room    = 'postType/post:' . $wp_rtc_bench_post_id;
	$wp_rtc_bench_client  = 4242;
	$wp_rtc_bench_head    = 0;
	$wp_rtc_bench_storage = new WP_RTC_Table_Storage();
	$wp_rtc_bench_storage->reset_room( $wp_rtc_bench_room );

	$wp_rtc_bench_intent = static function ( int $seq ) use ( $wp_rtc_bench_post_id, $wp_rtc_bench_paragraphs ): array {
		return array(
			'intentId' => 'bench-' . $seq,
			'baseSeq'  => $seq,
			'txnId'    => null,
			'type'     => 'insert_text',
			'payload'  => array(
				'syncId' => WP_Intent_Log_Planner::genesis_sync_id( $wp_rtc_bench_post_id, 0, array( $seq % $wp_rtc_bench_paragraphs ) ),
				'field'  => 'content',
				'offset' => 0,
				'text'   => 'x',
			),
		);
	};

	// Fill the room, one edit per request, so every edit is based on the
	// newest position and none needs adjusting.
	while ( $wp_rtc_bench_head < $wp_rtc_bench_size ) {
		wp_rtc_bench_long_history_commit( $wp_rtc_bench_room, $wp_rtc_bench_client, array( $wp_rtc_bench_intent( $wp_rtc_bench_head ) ) );
		++$wp_rtc_bench_head;
	}

	// A first read creates the room's first document when no edit has
	// done so yet, so the measured reads start from a room that exists.
	( new WP_Intent_Log_Engine( new WP_RTC_Table_Storage() ) )->get_updates_since( $wp_rtc_bench_room, $wp_rtc_bench_client, 0, array() );

	$wp_rtc_bench_stored = $wp_rtc_bench_storage->get_updates_after_cursor( $wp_rtc_bench_room, 0 );
	$wp_rtc_bench_bytes  = 0;
	foreach ( $wp_rtc_bench_stored as $wp_rtc_bench_row ) {
		$wp_rtc_bench_bytes += strlen( $wp_rtc_bench_row['data'] );
	}
	$wp_rtc_bench_cursor = $wp_rtc_bench_storage->get_cursor( $wp_rtc_bench_room );

	$wp_rtc_bench_commit_ms = array();
	$wp_rtc_bench_read_ms   = array();
	for ( $wp_rtc_bench_i = 0; $wp_rtc_bench_i < $wp_rtc_bench_samples; $wp_rtc_bench_i++ ) {
		// An idle read: nothing to send, nothing new to receive.
		$wp_rtc_bench_started = hrtime( true );
		$wp_rtc_bench_engine  = new WP_Intent_Log_Engine( new WP_RTC_Table_Storage() );
		$wp_rtc_bench_engine->handle_updates( $wp_rtc_bench_room, $wp_rtc_bench_client, $wp_rtc_bench_cursor, array(), array() );
		$wp_rtc_bench_answer    = $wp_rtc_bench_engine->get_updates_since( $wp_rtc_bench_room, $wp_rtc_bench_client, $wp_rtc_bench_cursor, array() );
		$wp_rtc_bench_read_ms[] = ( hrtime( true ) - $wp_rtc_bench_started ) / 1e6;
		if ( array() !== $wp_rtc_bench_answer['updates'] ) {
			fwrite( STDERR, "An idle read returned rows.\n" );
			exit( 1 );
		}

		// A commit of one typed character.
		$wp_rtc_bench_started = hrtime( true );
		wp_rtc_bench_long_history_commit( $wp_rtc_bench_room, $wp_rtc_bench_client, array( $wp_rtc_bench_intent( $wp_rtc_bench_head ) ) );
		$wp_rtc_bench_commit_ms[] = ( hrtime( true ) - $wp_rtc_bench_started ) / 1e6;
		++$wp_rtc_bench_head;

		// Find the newest row again, outside the measured time.
		$wp_rtc_bench_fresh = new WP_RTC_Table_Storage();
		$wp_rtc_bench_fresh->get_updates_after_cursor( $wp_rtc_bench_room, 0 );
		$wp_rtc_bench_cursor = $wp_rtc_bench_fresh->get_cursor( $wp_rtc_bench_room );
	}

	$wp_rtc_bench_results[] = array(
		'history'       => $wp_rtc_bench_size,
		'stored_rows'   => count( $wp_rtc_bench_stored ),
		'stored_bytes'  => $wp_rtc_bench_bytes,
		'samples'       => $wp_rtc_bench_samples,
		'commit_p50_ms' => wp_rtc_bench_long_history_percentile( $wp_rtc_bench_commit_ms, 0.5 ),
		'commit_p90_ms' => wp_rtc_bench_long_history_percentile( $wp_rtc_bench_commit_ms, 0.9 ),
		'read_p50_ms'   => wp_rtc_bench_long_history_percentile( $wp_rtc_bench_read_ms, 0.5 ),
		'read_p90_ms'   => wp_rtc_bench_long_history_percentile( $wp_rtc_bench_read_ms, 0.9 ),
	);

	$wp_rtc_bench_storage->reset_room( $wp_rtc_bench_room );
	wp_delete_post( $wp_rtc_bench_post_id, true );
}

$wp_rtc_bench_report = array(
	'scope'   => 'PHP engine with the real table storage, one request per sample, each on new storage and engine objects. No HTTP, no transport.',
	'results' => $wp_rtc_bench_results,
);

if ( '' !== $wp_rtc_bench_json ) {
	file_put_contents( $wp_rtc_bench_json, wp_json_encode( $wp_rtc_bench_report, JSON_PRETTY_PRINT ) . "\n" );
}

echo wp_json_encode( $wp_rtc_bench_report ) . "\n";
