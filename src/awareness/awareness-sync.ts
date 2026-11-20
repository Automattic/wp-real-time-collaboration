/**
 * Internal dependencies
 */
import type { AwarenessState } from '../registry/types';
import type { PresenceObject } from '../editor/gutenberg-contract';

/*
 * Carries presence between the transport and the editor. The server
 * returns every tab's presence state as plain JSON (client id to state) on
 * each exchange. The editor's presence display reads a presence object
 * that core-data builds (see PresenceObject in
 * src/editor/gutenberg-contract.ts). This file writes the one into the
 * other. Presence is transport data, so no engine logic lives here.
 *
 * The presence object is built over a document, of which it reads only
 * the `clientID` (and a 'destroy' listener). An engine without such a
 * document passes a stand-in (see createAwarenessDoc).
 */

/**
 * Creates the stand-in document the presence object is built over, for
 * an engine that has no Yjs document.
 *
 * @param clientID The transport client id.
 * @return A doc stub.
 */
export function createAwarenessDoc( clientID: number ): {
	clientID: number;
	on: () => void;
	off: () => void;
} {
	return { clientID, on: () => {}, off: () => {} };
}

/**
 * Removes clients from a presence object and tells its listeners.
 *
 * This does what the presence object's own package does when a client
 * leaves. The plugin has its own copy so that it does not load that
 * package a second time beside the one core-data bundles.
 *
 * @param awareness The presence object.
 * @param clients   The client ids to remove.
 * @param origin    Passed to listeners as the source of the change.
 */
function removePresenceStates(
	awareness: PresenceObject,
	clients: number[],
	origin: string
): void {
	const states = awareness.getStates();
	const removed: number[] = [];
	for ( const clientId of clients ) {
		if ( ! states.has( clientId ) ) {
			continue;
		}

		states.delete( clientId );

		// Losing this tab's own state moves its clock forward, so a later
		// state from this tab counts as newer everywhere.
		if ( clientId === awareness.clientID ) {
			const current = awareness.meta.get( clientId );
			let clock = 0;
			if ( current ) {
				clock = current.clock;
			}

			awareness.meta.set( clientId, {
				clock: clock + 1,
				lastUpdated: Date.now(),
			} );
		}

		removed.push( clientId );
	}

	if ( removed.length === 0 ) {
		return;
	}

	const change = { added: [], updated: [], removed };
	awareness.emit( 'change', [ change, origin ] );
	awareness.emit( 'update', [ change, origin ] );
}

/**
 * Applies a server-merged awareness state map onto a presence object:
 * adds/updates remote client states, removes clients absent from the server
 * state, skips the local client, and emits the change events subscribers
 * expect.
 *
 * @param state     Server awareness map (client id → state).
 * @param awareness The Awareness instance to update.
 * @param origin    Origin tag for removal events.
 */
export function applyServerAwarenessStates(
	state: AwarenessState,
	awareness: PresenceObject,
	origin: string
): void {
	const currentStates = awareness.getStates();
	const added = new Set< number >();
	const updated = new Set< number >();

	// Removed clients are missing from the server state.
	const removed = new Set< number >(
		Array.from( currentStates.keys() ).filter(
			( clientId ) => ! state[ clientId ]
		)
	);

	Object.entries( state ).forEach( ( [ clientIdString, awarenessState ] ) => {
		const clientId = Number( clientIdString );

		// Skip our own state (we already have it locally).
		if ( clientId === awareness.clientID ) {
			return;
		}

		// A null state should be removed by the server, but handle it here just in case.
		if ( null === awarenessState ) {
			currentStates.delete( clientId );
			removed.add( clientId );
			return;
		}

		if ( ! currentStates.has( clientId ) ) {
			currentStates.set( clientId, awarenessState );
			added.add( clientId );
			return;
		}

		const currentState = currentStates.get( clientId );

		if (
			JSON.stringify( currentState ) !== JSON.stringify( awarenessState )
		) {
			currentStates.set( clientId, awarenessState );
			updated.add( clientId );
		}
	} );

	if ( added.size + updated.size > 0 ) {
		awareness.emit( 'change', [
			{
				added: Array.from( added ),
				updated: Array.from( updated ),
				// Left blank on purpose, as the removal of clients is handled in the if condition below.
				removed: [],
			},
		] );
	}

	if ( removed.size > 0 ) {
		removePresenceStates( awareness, Array.from( removed ), origin );
	}
}
