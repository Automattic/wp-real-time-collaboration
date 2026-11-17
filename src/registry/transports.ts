/**
 * The transports this browser can use, and the choice of one.
 *
 * A transport registers under a slug. The server announces the slugs it
 * supports, the active one first (`window._wpCollaborationSync`, printed
 * by the plugin's PHP). The browser uses the first announced slug it has
 * registered at the announced protocol version. With no match, no room
 * connects and the editor falls back to the post lock.
 */

/**
 * WordPress dependencies
 */
import { applyFilters } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import type { ProviderCreator } from './types';

/** One transport this browser can use. */
export interface TransportRegistration {
	slug: string;
	protocolVersion: number;
	create: () => ProviderCreator;
}

/** What the server announces about transports. */
interface AnnouncedTransports {
	transports: string[];
	transportProtocol: number;
}

interface CollaborationWindow {
	__experimentalEnableRealTimeCollaboration?: boolean;
	_wpCollaborationSync?: {
		transports?: string[];
		transportProtocol?: number;
	};
}

let providerCreators: ProviderCreator[] | null = null;
const registeredTransports: TransportRegistration[] = [];

function isTransportRegistration(
	candidate: Partial< TransportRegistration > | null | undefined
): candidate is TransportRegistration {
	return (
		!! candidate &&
		'object' === typeof candidate &&
		'string' === typeof candidate.slug &&
		'function' === typeof candidate.create
	);
}

/**
 * Registers a transport. The next choice of a transport can pick it.
 *
 * @param transport The transport to register.
 */
export function registerSyncTransport(
	transport: TransportRegistration
): void {
	if ( ! isTransportRegistration( transport ) ) {
		return;
	}

	registeredTransports.push( transport );
	providerCreators = null;
}

/**
 * Reads the server's announcement, or null when there is none.
 */
function getAnnouncedTransports(): AnnouncedTransports | null {
	const announced = ( window as CollaborationWindow )._wpCollaborationSync;
	if ( ! announced ) {
		return null;
	}

	let transports: string[] = [];
	if ( Array.isArray( announced.transports ) ) {
		transports = announced.transports;
	}

	let transportProtocol = 1;
	if ( 'number' === typeof announced.transportProtocol ) {
		transportProtocol = announced.transportProtocol;
	}

	return { transports, transportProtocol };
}

/**
 * The registered transports, after other code had a chance to add its own
 * through the `sync.transports` filter.
 */
function getRegisteredTransports(): TransportRegistration[] {
	const filtered = applyFilters( 'sync.transports', [
		...registeredTransports,
	] );
	if ( ! Array.isArray( filtered ) ) {
		return [];
	}

	return filtered.filter( isTransportRegistration );
}

/**
 * Picks the first announced transport this browser has registered at the
 * announced protocol version.
 */
function negotiateTransport(): ProviderCreator | null {
	const announced = getAnnouncedTransports();
	if ( ! announced ) {
		return null;
	}

	const registered = getRegisteredTransports();
	for ( const slug of announced.transports ) {
		const match = registered.find(
			( transport ) =>
				transport.slug === slug &&
				transport.protocolVersion === announced.transportProtocol
		);
		if ( match ) {
			return match.create();
		}
	}

	return null;
}

/**
 * The connect functions of the transport in use: one entry, or none when
 * the server and the browser share no transport. The `sync.providers`
 * filter can replace the list, which the tests use.
 */
export function getProviderCreators(): ProviderCreator[] {
	if ( providerCreators ) {
		return providerCreators;
	}

	if (
		! ( window as CollaborationWindow )
			.__experimentalEnableRealTimeCollaboration
	) {
		return [];
	}

	const negotiated = negotiateTransport();
	let defaults: ProviderCreator[] = [];
	if ( negotiated ) {
		defaults = [ negotiated ];
	}

	const filtered = applyFilters( 'sync.providers', defaults );
	if ( ! Array.isArray( filtered ) ) {
		providerCreators = [];

		return providerCreators;
	}

	providerCreators = filtered.filter(
		( creator ): creator is ProviderCreator => 'function' === typeof creator
	);

	return providerCreators;
}

/**
 * Forgets every registered transport and the choice made. For tests only.
 */
export function resetProviderCreatorsForTesting(): void {
	providerCreators = null;
	registeredTransports.length = 0;
}
