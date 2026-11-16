/**
 * Logs in once and puts the site in a known state.
 */

/**
 * External dependencies
 */
import { request } from '@playwright/test';

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Resolved via the plugin's own devDependency.
import { RequestUtils } from '@wordpress/e2e-test-utils-playwright';

export default async function globalSetup( config ) {
	const { storageState, baseURL } = config.projects[ 0 ].use;
	const requestContext = await request.newContext( { baseURL } );
	const requestUtils = new RequestUtils( requestContext, {
		storageStatePath: storageState,
		baseURL,
	} );

	await requestUtils.setupRest();
	await requestUtils.deleteAllPosts();
	await requestUtils.deleteAllBlocks();
	await requestUtils.resetPreferences();
	await requestContext.dispose();
}
