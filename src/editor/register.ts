/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.coreData.
import { privateApis } from '@wordpress/core-data';

/**
 * Internal dependencies
 */
import { resolveSyncEngine } from '../registry/engines';
import type {
	EntitySyncContext,
	EntitySyncManager,
} from './gutenberg-contract';
import { unlockCoreData } from './lock-unlock';

/*
 * The one place where the plugin registers with the editor.
 *
 * core-data has a single registration point for a sync provider,
 * `registerEntitySyncProvider`, behind its private APIs. The plugin hands
 * it the provider of the engine the server announced. This must run
 * before the editor loads its first record.
 *
 * Nothing is registered when collaboration is off, when the server
 * announced an engine this browser does not have, or when the Gutenberg
 * on the page has no such registration point. With collaboration on and
 * no provider, the editor falls back to the post lock by itself.
 */

/** The private API of core-data the plugin uses. */
interface CoreDataPrivateApis {
	registerEntitySyncProvider?: (
		create: ( context: EntitySyncContext ) => EntitySyncManager
	) => () => void;
}

/**
 * Registers the announced engine's provider with core-data.
 *
 * @return Undoes the registration and stops the provider. Does nothing
 *         when nothing was registered.
 */
export function registerEngineWithEditor(): () => void {
	const { __experimentalEnableRealTimeCollaboration: enabled } = window as {
		__experimentalEnableRealTimeCollaboration?: boolean;
	};
	const engine = resolveSyncEngine();

	if ( ! enabled || ! engine ) {
		return () => {};
	}

	const { registerEntitySyncProvider }: CoreDataPrivateApis =
		unlockCoreData( privateApis );

	if ( 'function' !== typeof registerEntitySyncProvider ) {
		return () => {};
	}

	let provider: EntitySyncManager | undefined;
	const unregister = registerEntitySyncProvider( ( context ) => {
		provider = engine.createProvider( context );

		return provider;
	} );

	return () => {
		unregister();
		provider?.unloadAll();
	};
}
