/**
 * What this plugin still takes at runtime from Gutenberg's
 * `@wordpress/sync` package. These values sit behind that package's
 * private API, so they are unlocked once here and re-exported.
 *
 * The transport registry and the connection error types are not here any
 * more. The plugin owns them (src/registry/).
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import { privateApis } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { unlock } from './lock-unlock';

const api = unlock( privateApis );

export const registerSyncEngine = api.registerSyncEngine;
export const createSyncManager = api.createSyncManager;
export const resolveEngineAdapter = api.resolveEngineAdapter;

// Origin marker for editor-originated updates (used by the yjs undo manager
// and its tests).
export const LOCAL_EDITOR_ORIGIN = api.LOCAL_EDITOR_ORIGIN;

// Origin marker for editor updates that must sync but never become undo
// steps (core-data's `undoIgnore` edits and save responses).
export const LOCAL_UNDO_IGNORED_ORIGIN = api.LOCAL_UNDO_IGNORED_ORIGIN;

// Test-support: reset the framework's registries between unit tests. The
// second one resets the framework's own transport list, which only the
// framework's `createSyncManager` reads. The plugin's transports reset
// through src/registry/transports.ts.
export const getEngineAdapters = api.getEngineAdapters;
export const resetEngineAdaptersForTesting = api.resetEngineAdaptersForTesting;
export const resetFrameworkProviderCreatorsForTesting =
	api.resetProviderCreatorsForTesting;
