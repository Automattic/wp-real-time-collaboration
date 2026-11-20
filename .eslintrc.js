/**
 * ESLint config, mirroring Gutenberg's TypeScript setup: the WordPress
 * eslint plugin's recommended ruleset, with the sync framework externalized
 * to the `wp.sync` global at build time (see the dependency-extraction note
 * in README).
 *
 * @type {import('eslint').Linter.Config}
 */
module.exports = {
	root: true,
	extends: [ 'plugin:@wordpress/eslint-plugin/recommended' ],
	// The pinned Gutenberg subtree and generated output are never linted here.
	ignorePatterns: [
		'gutenberg/**',
		'build/**',
		'vendor/**',
	],
	settings: {
		'import/resolver': {
			node: {
				extensions: [ '.js', '.ts', '.tsx' ],
			},
		},
	},
	overrides: [
		{
			files: [ '**/*.ts', '**/*.tsx' ],
			parser: '@typescript-eslint/parser',
		},
		{
			// The engine and the room state know nothing about the editor
			// or WordPress, so they can run in Node and in tests alone.
			files: [ 'src/engines/**', 'src/replica/**' ],
			rules: {
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [ '@wordpress/*' ],
								message:
									'The engine and the room state must not import WordPress packages. Code that talks to the editor belongs in src/editor/.',
							},
						],
					},
				],
			},
		},
		{
			// A transport only sends and receives. It may make requests
			// and read the public filters, and nothing else.
			files: [ 'src/transports/**', 'src/registry/**' ],
			rules: {
				'no-restricted-imports': [
					'error',
					{
						patterns: [
							{
								group: [
									'@wordpress/*',
									'!@wordpress/api-fetch',
									'!@wordpress/hooks',
								],
								message:
									'Transports and the registries may import only @wordpress/api-fetch and @wordpress/hooks. Code that talks to the editor belongs in src/editor/.',
							},
						],
					},
				],
			},
		},
		{
			// Everything the plugin takes from Gutenberg that is not
			// public goes through src/editor/gutenberg-contract.ts.
			files: [
				'src/awareness/**',
				'src/review/**',
				'src/debug/**',
				'src/index.ts',
			],
			rules: {
				'no-restricted-imports': [
					'error',
					{
						paths: [
							{
								name: '@wordpress/private-apis',
								message:
									'Read private Gutenberg APIs through src/editor/ only.',
							},
						],
					},
				],
			},
		},
		{
			// The Jest setup files use the framework globals directly (the
			// tests themselves import from @jest/globals instead).
			files: [ 'tests/js/**/*.js' ],
			env: {
				es2021: true,
				jest: true,
			},
		},
		{
			// The conflict review UI's component tests import the editor
			// packages and Testing Library, which Jest resolves from the
			// vendored subtree (see jest.config.js), not from this
			// package's own dependencies.
			files: [ 'tests/js/review/**/*.{js,jsx}' ],
			rules: {
				'import/no-extraneous-dependencies': 'off',
				'import/no-unresolved': 'off',
			},
		},
		{
			// The frozen JS engine core is a vendored cross-language contract
			// (byte-matched against its PHP twin and JSON vectors); do not
			// reformat or relint it here. It targets a Node-style runtime
			// (its harness lives in tests/js/engines/intent-log/, its vector
			// generators in tests/tools/), so give it the Node and modern-ES
			// globals rather than this plugin's browser env.
			files: [ 'src/engines/intent-log/**/*.js' ],
			env: {
				browser: true,
				es2021: true,
				jest: true,
				node: true,
			},
			rules: {
				'@wordpress/no-unused-vars-before-return': 'off',
				'no-console': 'off',
				'import/no-extraneous-dependencies': 'off',
			},
		},
		{
			// Node CLI scripts (vector generators, simulator sweep, manual
			// two-tab observer, benchmark tools) — they print to stdout by
			// design.
			files: [
				'tests/tools/**/*.{js,mjs}',
				'tests/benchmarks/**/*.{js,mjs}',
			],
			env: {
				es2021: true,
				node: true,
			},
			rules: {
				'no-console': 'off',
				'import/no-extraneous-dependencies': 'off',
			},
		},
	],
};
