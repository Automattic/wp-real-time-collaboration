/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import type { SyncPayload, SyncResponse } from './types';

// The REST path the polling manager posts to.
const syncApiPath = '/wp-rtc/v1/updates';

/**
 * Post a sync update and receive updates the client is missing.
 *
 * @param payload The sync payload including data and after cursor
 * @return The sync server response
 */
export function postSyncUpdate(
	payload: SyncPayload
): Promise< SyncResponse > {
	return apiFetch( {
		method: 'POST',
		path: syncApiPath,
		data: payload,
	} );
}

/**
 * Fire-and-forget variant of postSyncUpdate. Uses `keepalive` so the
 * request survives page unload, and errors are silently ignored.
 *
 * @param payload The sync payload to send.
 */
export function postSyncUpdateNonBlocking( payload: SyncPayload ): void {
	if ( payload.rooms.length === 0 ) {
		return;
	}

	apiFetch( {
		method: 'POST',
		path: syncApiPath,
		data: payload,
		keepalive: true,
	} ).catch( () => {} );
}

/**
 * Parse an integer from an unknown value, returning a default if parsing fails.
 *
 * @param value        The value to parse as an integer.
 * @param defaultValue The default value to return if parsing fails.
 * @return The parsed integer or the default value.
 */
export function intValueOrDefault(
	value: unknown,
	defaultValue: number
): number {
	const intValue = parseInt( String( value ), 10 );

	return isNaN( intValue ) ? defaultValue : intValue;
}

/**
 * Take `size` items from `items` starting at `offset`, wrapping around the
 * end of the list. Returns the selected window and the offset to use on the
 * next call (advanced by `size`).
 *
 * @param items  The list to rotate through.
 * @param offset The starting index. Values larger than `items.length` are
 *               wrapped (modulo).
 * @param size   The maximum number of items to include in the window. The
 *               window may be shorter if `size` exceeds `items.length`.
 */
export function rotateWindow< T >(
	items: T[],
	offset: number,
	size: number
): { window: T[]; nextOffset: number } {
	if ( items.length === 0 ) {
		return { window: [], nextOffset: 0 };
	}

	const start = ( ( offset % items.length ) + items.length ) % items.length;
	const wrapped = [ ...items.slice( start ), ...items.slice( 0, start ) ];

	return {
		window: wrapped.slice( 0, Math.max( 0, size ) ),
		nextOffset: ( start + Math.max( 0, size ) ) % items.length,
	};
}
