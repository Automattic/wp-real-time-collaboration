/**
 * The sync-transport channel: the block name rides the framework's own
 * awareness state, as one more field beside `collaboratorInfo`.
 *
 * Nothing between `setLocalStateField` and the peers' `onStateChange`
 * inspects awareness content (the server stores it opaquely), so this
 * needs no engine, transport, or PHP change and works over http-polling
 * and websocket alike. Under short polling the advisory channel's
 * presence lane carries the field to every reachable peer within a
 * moment, and the timer polls carry it to the rest; under websocket it
 * goes with the periodic awareness frame. The Heartbeat channel is the one
 * with its own cadence.
 *
 * The controller suppresses the framework's live-cursor field
 * (`editorState`) on the local state for as long as slow awareness runs
 * (`suppressRealtimeSelection`, below), and the registry installs the
 * field's equality check on every awareness instance the engines create,
 * so this channel only publishes and subscribes.
 */

/**
 * Internal dependencies
 */
import type { Channel, PeerIdentity, PeerRoster } from '../types';
import type { PostEditorPresenceObject } from '../../editor/gutenberg-contract';

/** The sync channel: the publisher hands it each new block. */
export interface SyncChannel extends Channel {
	publish: ( block: string | null ) => void;
}

/**
 * The presence object this channel relies on: the one core-data builds
 * for a post (see src/editor/gutenberg-contract.ts), with its listener
 * helper typed for this channel's peer states.
 */
export interface AwarenessHost
	extends Pick<
		PostEditorPresenceObject,
		| 'clientID'
		| 'setUp'
		| 'setLocalStateField'
		| 'getLocalState'
		| 'equalityFieldChecks'
	> {
	onStateChange?: (
		callback: ( states: AwarenessPeerState[] ) => void
	) => () => void;
}

export interface AwarenessPeerState {
	clientId: number;
	isMe: boolean;
	isConnected: boolean;
	collaboratorInfo?: {
		id: number | null;
		name: string;
		avatar_urls?: Record< string, string >;
	};
	wpRtcBlock?: string | null;
}

/** The awareness field the block name travels in. */
export const BLOCK_FIELD = 'wpRtcBlock';

export interface SyncChannelOptions {
	awareness: AwarenessHost;
	onPeers: PeerRoster;
}

/**
 * Whether two block-field values are the same (absent and null alike).
 *
 * @param a A value.
 * @param b Another value.
 * @return True when equal.
 */
export function areBlocksEqual( a?: unknown, b?: unknown ): boolean {
	return ( a ?? null ) === ( b ?? null );
}

/**
 * Reads the identity a peer's collaborator info describes.
 *
 * @param state A peer's awareness state.
 * @return The identity.
 */
export function identityFromState( state: AwarenessPeerState ): PeerIdentity {
	const info = state.collaboratorInfo;
	const avatars = info?.avatar_urls ?? {};
	const avatarUrl = avatars[ '48' ] ?? avatars[ '96' ] ?? avatars[ '24' ];
	return {
		userId: info?.id ?? null,
		name: info?.name ?? '',
		avatarUrl,
	};
}

/**
 * Stops the framework's live-cursor field (`editorState`) from being
 * published on the local awareness state, and clears the one already
 * published. Peers then see the block outline only.
 *
 * @param awareness The awareness instance.
 * @return A function restoring the original setter.
 */
export function suppressRealtimeSelection(
	awareness: AwarenessHost
): () => void {
	const original = awareness.setLocalStateField.bind( awareness );
	awareness.setLocalStateField = ( field, value ) => {
		if ( 'editorState' === field ) {
			return;
		}
		original( field, value );
	};
	if ( awareness.getLocalState()?.editorState ) {
		original( 'editorState', undefined );
	}
	return () => {
		awareness.setLocalStateField = original;
	};
}

/**
 * Creates the sync-transport channel.
 *
 * @param options Channel options.
 * @return The channel.
 */
export function createSyncChannel( options: SyncChannelOptions ): SyncChannel {
	const { awareness, onPeers } = options;
	let unsubscribe: ( () => void ) | null = null;

	return {
		start() {
			awareness.setUp?.();
			unsubscribe =
				awareness.onStateChange?.( ( states ) => {
					onPeers(
						states
							.filter(
								( state ) => ! state.isMe && state.isConnected
							)
							.map( ( state ) => ( {
								key: String( state.clientId ),
								identity: identityFromState( state ),
								block: state.wpRtcBlock ?? null,
							} ) )
					);
				} ) ?? null;
		},
		stop() {
			unsubscribe?.();
			unsubscribe = null;
			awareness.setLocalStateField( BLOCK_FIELD, undefined );
		},
		publish( block ) {
			awareness.setLocalStateField( BLOCK_FIELD, block );
		},
	};
}
