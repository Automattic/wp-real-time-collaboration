/**
 * Playwright config for the edit batch recorder.
 *
 * It does not start a site. Point it at a running site that has the new
 * Gutenberg branch and the recorder plugin active (see README.md).
 */

/**
 * External dependencies
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The WordPress test helpers read the site address from this variable and
// fall back to port 8889, which is this plugin's own tests site. Set it
// here so they can never reach that site by accident.
process.env.WP_BASE_URL = process.env.WP_BASE_URL || 'http://localhost:8895';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const artifacts = path.join( here, '../../../artifacts/edit-batch-recorder' );
const storageState = path.join( artifacts, 'storage-state.json' );

// The helpers also read the login cookies from a file named by this
// variable. Keep this site's cookies apart from the tests site's.
process.env.STORAGE_STATE_PATH = storageState;

export default defineConfig( {
	testDir: here,
	testMatch: 'record.spec.mjs',
	globalSetup: path.join( here, 'global-setup.mjs' ),
	outputDir: path.join( artifacts, 'test-results' ),
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 120_000,
	reporter: [ [ 'list' ] ],
	use: {
		baseURL: process.env.WP_BASE_URL,
		storageState,
		actionTimeout: 10_000,
		navigationTimeout: 30_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		permissions: [ 'clipboard-read', 'clipboard-write' ],
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices[ 'Desktop Chrome' ] },
		},
	],
} );
