/**
 * WordPress dependencies
 */
const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );

/**
 * The plugin ships one browser script. It registers the engine and the
 * transports, and hands the engine to the editor.
 *
 * The WordPress packages it imports (`@wordpress/core-data`,
 * `@wordpress/blocks`, and so on) are not bundled. The default config
 * turns each into the matching `wp.*` global and lists it as a script
 * dependency, so the plugin uses the same copies as the editor.
 */
module.exports = {
	...defaultConfig,
	entry: {
		'wp-rtc': './src/index.ts',
	},
};
