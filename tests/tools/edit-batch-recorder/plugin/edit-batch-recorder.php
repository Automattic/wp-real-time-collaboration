<?php
/**
 * Plugin Name: Edit Batch Recorder
 * Description: Test-only. Turns collaboration on and registers a sync provider that only records what Gutenberg sends it. See tests/tools/edit-batch-recorder/README.md.
 * Version: 0.0.1
 *
 * @package wp-real-time-collaboration
 */

// Turn collaboration on without the Gutenberg experiment.
add_filter( 'wp_is_collaboration_enabled', '__return_true' );

// Gutenberg turns collaboration off for post types without custom fields.
// That rule only applies to its own Yjs engine, so undo it at a late priority.
add_filter( 'wp_is_post_type_collaboration_disabled', '__return_false', 1000 );

/**
 * Registers a meta field the recorder script edits, so the recording shows
 * what a meta change looks like.
 */
function edit_batch_recorder_register_meta() {
	register_post_meta(
		'post',
		'edit_batch_recorder_note',
		array(
			'show_in_rest'  => true,
			'single'        => true,
			'type'          => 'string',
			'default'       => '',
			'auth_callback' => static function () {
				return current_user_can( 'edit_posts' );
			},
		)
	);
}
add_action( 'init', 'edit_batch_recorder_register_meta' );

/**
 * Prints the recorder right after core-data, so the provider is registered
 * before the editor loads its first record.
 */
function edit_batch_recorder_enqueue() {
	$script = file_get_contents( __DIR__ . '/recorder.js' );
	if ( false === $script ) {
		return;
	}

	wp_add_inline_script( 'wp-core-data', $script, 'after' );
}
add_action( 'admin_init', 'edit_batch_recorder_enqueue', 20 );
