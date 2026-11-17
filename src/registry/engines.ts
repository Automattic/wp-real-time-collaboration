/**
 * The sync engines this browser can use, and the choice of one.
 *
 * An engine decides what an edit means: how local changes become
 * updates, and how received updates change the editor. A transport only
 * moves the updates (see transports.ts).
 *
 * An engine registers under a slug. The server announces the engine a
 * site uses (`window._wpCollaborationSync`, printed by the plugin's PHP)
 * and refuses a tab that speaks another one. The browser uses the
 * announced engine when it has it registered at the announced protocol
 * version. With no match, nothing is registered with the editor, and the
 * editor falls back to the post lock.
 */

/**
 * WordPress dependencies
 */
import { applyFilters } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import type {
	EntitySyncContext,
	EntitySyncManager,
} from '../editor/gutenberg-contract';

/** One engine this browser can use. */
export interface SyncEngineRegistration {
	/** The engine's name, the same as the server engine's. */
	slug: string;

	/**
	 * The version of the engine's messages. It must equal the server
	 * engine's version for the browser to join.
	 */
	protocolVersion: number;

	/**
	 * Creates the engine's provider: the object core-data calls for loads,
	 * edits, saves and undo.
	 */
	createProvider: ( context: EntitySyncContext ) => EntitySyncManager;
}

interface CollaborationWindow {
	_wpCollaborationSync?: {
		engine?: string;
		engineProtocol?: number;
	};
}

const registeredEngines: SyncEngineRegistration[] = [];

/**
 * Whether a value is an engine registration.
 *
 * @param candidate Any value.
 * @return Whether it has a slug, a version and a way to make a provider.
 */
function isEngineRegistration(
	candidate: Partial< SyncEngineRegistration > | null | undefined
): candidate is SyncEngineRegistration {
	return (
		!! candidate &&
		'object' === typeof candidate &&
		'string' === typeof candidate.slug &&
		'number' === typeof candidate.protocolVersion &&
		'function' === typeof candidate.createProvider
	);
}

/**
 * Registers an engine. A later registration of the same slug wins.
 *
 * @param engine The engine.
 */
export function registerSyncEngine( engine: SyncEngineRegistration ): void {
	if ( isEngineRegistration( engine ) ) {
		registeredEngines.push( engine );
	}
}

/**
 * The registered engines by slug, after other code had a chance to add
 * its own through the `sync.engines` filter.
 *
 * @return The engines.
 */
export function getSyncEngines(): Record< string, SyncEngineRegistration > {
	const filtered = applyFilters( 'sync.engines', [ ...registeredEngines ] );
	const engines: Record< string, SyncEngineRegistration > = {};

	if ( Array.isArray( filtered ) ) {
		for ( const engine of filtered ) {
			if ( isEngineRegistration( engine ) ) {
				engines[ engine.slug ] = engine;
			}
		}
	}

	return engines;
}

/**
 * Picks the engine the server announced.
 *
 * @return The engine, or null when the server announced none, or one this
 *         browser does not have at the announced version. The browser
 *         must then join no room.
 */
export function resolveSyncEngine(): SyncEngineRegistration | null {
	const announced = ( window as CollaborationWindow )._wpCollaborationSync;

	if (
		! announced ||
		'string' !== typeof announced.engine ||
		'number' !== typeof announced.engineProtocol
	) {
		return null;
	}

	const engine = getSyncEngines()[ announced.engine ];

	if ( ! engine || engine.protocolVersion !== announced.engineProtocol ) {
		return null;
	}

	return engine;
}

/**
 * Forgets every registered engine. For tests only.
 */
export function resetSyncEnginesForTesting(): void {
	registeredEngines.length = 0;
}
