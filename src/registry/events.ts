/**
 * A small event class for a transport's room connection.
 */

/**
 * Internal dependencies
 */
import type { ProviderEventMap } from './types';

type Listener< K extends keyof ProviderEventMap > = (
	data: ProviderEventMap[ K ]
) => void;

type Listeners = {
	[ K in keyof ProviderEventMap ]: Set< Listener< K > >;
};

export class ProviderEvents {
	// One set per event in ProviderEventMap. A new event needs a line here.
	private listeners: Listeners = { status: new Set() };

	/**
	 * Calls `callback` every time `event` is reported.
	 *
	 * @param event    The event name.
	 * @param callback The listener.
	 */
	public on< K extends keyof ProviderEventMap >(
		event: K,
		callback: Listener< K >
	): void {
		this.listeners[ event ].add( callback );
	}

	/**
	 * Reports an event to its listeners.
	 *
	 * @param event The event name.
	 * @param data  What the listeners receive.
	 */
	protected emit< K extends keyof ProviderEventMap >(
		event: K,
		data: ProviderEventMap[ K ]
	): void {
		// Copy first: a listener may remove the connection, which clears
		// the set while it is being walked.
		for ( const listener of Array.from( this.listeners[ event ] ) ) {
			listener( data );
		}
	}

	/** Forgets every listener. */
	public destroy(): void {
		this.listeners.status.clear();
	}
}
