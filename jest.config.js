/**
 * External dependencies
 */
const path = require( 'path' );

/**
 * WordPress dependencies
 */
const defaultConfig = require( '@wordpress/scripts/config/jest-unit.config.js' );

// The editor packages come from the bundled Gutenberg in `./gutenberg`, the
// same copy wp-env and the browser tests run against. It must be installed
// and built (see Setup in AGENTS.md).
//
// Gutenberg installs its dependencies per package: each package folder has
// its own `node_modules` with links into one shared store, and the root
// `node_modules` holds almost nothing. So a `@wordpress/*` import is mapped
// to the package's folder, and React and Testing Library are taken from one
// package that has them. Every package links to the same copies.
const FRAMEWORK_ROOT = path.resolve( __dirname, 'gutenberg' );
const FRAMEWORK_PACKAGES = path.join( FRAMEWORK_ROOT, 'packages' );
const REACT_HOME = path.join( FRAMEWORK_PACKAGES, 'element/node_modules' );
const TESTING_LIBRARY_HOME = path.join(
	FRAMEWORK_PACKAGES,
	'components/node_modules/@testing-library'
);

module.exports = {
	...defaultConfig,
	// Discover ONLY this plugin's own tests. The bundled Gutenberg in
	// `gutenberg/` carries thousands of test files of its own. Without this
	// restriction Jest would go into it and run (and fail) them.
	roots: [ '<rootDir>/src', '<rootDir>/tests' ],
	// The frozen cross-language vector replay locates its fixture through
	// `import.meta.url`. Jest runs CommonJS, so a plugin transforms it away.
	// Overriding `transform` (rather than adding a project babel config)
	// keeps this scoped to Jest and leaves the webpack build's babel
	// untouched.
	transform: {
		'\\.(?:mjs|[jt]sx?)$': [
			require.resolve( 'babel-jest' ),
			{
				presets: [
					require.resolve( '@wordpress/babel-preset-default' ),
				],
				plugins: [
					require.resolve( 'babel-plugin-transform-import-meta' ),
				],
			},
		],
	},
	moduleNameMapper: {
		...( defaultConfig.moduleNameMapper || {} ),
		// Use this plugin's own CommonJS uuid and API-fetch with this Jest
		// runner.
		'^uuid$': require.resolve( 'uuid' ),
		'^@wordpress/api-fetch$': require.resolve( '@wordpress/api-fetch' ),
		// A package that ships ES modules only (no `require` entry in its
		// export map) is mapped to its module build by file, which
		// babel-jest transforms.
		'^@wordpress/theme$': path.join(
			FRAMEWORK_PACKAGES,
			'theme/build-module/index.mjs'
		),
		// The block editor's files import each other in circles. Its
		// CommonJS build then finds some components still undefined while
		// it loads (the block list inside the block preview and inside
		// inner blocks), and a block that holds other blocks cannot render.
		// Its module build, transformed by babel-jest, loads in the order
		// the browser uses.
		'^@wordpress/block-editor$': path.join(
			FRAMEWORK_PACKAGES,
			'block-editor/build-module/index.mjs'
		),
		// The browser test utilities and the Jest tooling are this
		// plugin's own. Gutenberg runs its tests with another runner.
		'^@wordpress/e2e-test-utils-playwright$': require.resolve(
			'@wordpress/e2e-test-utils-playwright'
		),
		'^@wordpress/(jest-console|jest-preset-default)(.*)$': path.join(
			__dirname,
			'node_modules/@wordpress/$1$2'
		),
		// Every other editor package, React, and Testing Library must
		// resolve to ONE copy, Gutenberg's, or hooks, stores and the
		// private-API lock split across duplicates. These come after the
		// specific entries above, so those keep winning.
		'^@wordpress/(.*)$': path.join( FRAMEWORK_PACKAGES, '$1' ),
		'^react$': path.join( REACT_HOME, 'react' ),
		'^react/(.*)$': path.join( REACT_HOME, 'react/$1' ),
		'^react-dom$': path.join( REACT_HOME, 'react-dom' ),
		'^react-dom/(.*)$': path.join( REACT_HOME, 'react-dom/$1' ),
		'^@testing-library/(.*)$': path.join( TESTING_LIBRARY_HOME, '$1' ),
	},
	// A few dependencies of the editor packages ship ES modules only. Jest
	// runs CommonJS, so babel-jest transforms those. Every other
	// `node_modules` package is left as it is. Gutenberg keeps its
	// dependencies in `node_modules/.store/<name>@<version>/node_modules/`,
	// so the first `node_modules` in such a path is skipped and the second
	// one decides.
	transformIgnorePatterns: [
		'/node_modules/(?!\\.store/)(?!(uuid|marked|parsel-js|client-zip)/)',
		'\\.pnp\\.[^\\/]+$',
	],
	setupFiles: [
		...( defaultConfig.setupFiles || [] ),
		path.join( __dirname, 'tests/js/jest-setup.js' ),
	],
	setupFilesAfterEnv: [
		...( defaultConfig.setupFilesAfterEnv || [] ),
		path.join( __dirname, 'tests/js/jest-setup-after-env.js' ),
	],
};
