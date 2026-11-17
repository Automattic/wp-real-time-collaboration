/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

/**
 * WordPress dependencies
 */
import { addFilter, removeFilter } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import { createCollectionRooms } from '../../../src/editor/collections';
import type { EntitySyncContext } from '../../../src/editor/gutenberg-contract';
import { resetProviderCreatorsForTesting } from '../../../src/registry/transports';
import type { ProviderCreator } from '../../../src/registry/types';
import {
	connectToWire,
	createWireServer,
	type WireLink,
	type WireServer,
} from './wire';

const FILTER = 'sync.providers';
const NAMESPACE = 'wp-real-time-collaboration/collections-test';

let wire: WireServer;
let links: WireLink[] = [];

const transport: ProviderCreator = async ( { session } ) => {
	links.push(
		connectToWire(
			wire,
			session as Parameters< typeof connectToWire >[ 1 ]
		)
	);

	return { destroy: () => {}, on: () => {} };
};

const context: EntitySyncContext = {
	getSyncConfig: () => ( {} ),
	recordHandlers: () => ( { onStatusChange: () => {} } ),
	collectionHandlers: () => ( { onStatusChange: () => {} } ),
};

/**
 * One tab that has the list of categories open.
 *
 * @return The tab's rooms, its connection, and its refetch spy.
 */
async function openList() {
	const refetchRecords = jest.fn( async () => {} );
	const rooms = createCollectionRooms( context, 7 );
	const before = links.length;

	await rooms.load( 'taxonomy', 'category', { refetchRecords } );

	const link = links[ before ];

	link.poll();
	// The room notes the other tabs' values right after the first burst.
	await Promise.resolve();

	return { rooms, link, refetchRecords };
}

beforeEach( () => {
	(
		window as { __experimentalEnableRealTimeCollaboration?: boolean }
	 ).__experimentalEnableRealTimeCollaboration = true;
	resetProviderCreatorsForTesting();
	addFilter( FILTER, NAMESPACE, () => [ transport ] );
	links = [];
	wire = createWireServer( [] );
} );

afterEach( () => {
	removeFilter( FILTER, NAMESPACE );
	resetProviderCreatorsForTesting();
} );

describe( 'collection rooms', () => {
	it( 'fetches the list again when another tab saves a record of that kind', async () => {
		const alice = await openList();
		const bob = await openList();

		alice.rooms.announceSave( 'taxonomy/category' );
		alice.link.poll();
		bob.link.poll();

		expect( bob.refetchRecords ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'does not fetch the list again for the tab’s own save', async () => {
		const alice = await openList();

		alice.rooms.announceSave( 'taxonomy/category' );
		alice.link.poll();
		alice.link.poll();

		expect( alice.refetchRecords ).not.toHaveBeenCalled();
	} );

	it( 'does not fetch the list again for saves made before the tab joined', async () => {
		const alice = await openList();

		alice.rooms.announceSave( 'taxonomy/category' );
		alice.link.poll();

		// Bob's list was fetched right before he joined.
		const bob = await openList();

		expect( bob.refetchRecords ).not.toHaveBeenCalled();
	} );

	it( 'announces a save made before the room’s first document arrived', async () => {
		const alice = await openList();
		const rooms = createCollectionRooms( context, 8 );

		await rooms.load( 'taxonomy', 'category', {
			refetchRecords: async () => {},
		} );
		rooms.announceSave( 'taxonomy/category' );

		const link = links.at( -1 );

		link?.poll();
		link?.poll();
		alice.link.poll();

		expect( alice.refetchRecords ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'ignores a save of a kind it has no room for', async () => {
		const alice = await openList();

		expect( () =>
			alice.rooms.announceSave( 'taxonomy/post_tag' )
		).not.toThrow();
		expect( alice.link.queued() ).toBe( 0 );
	} );
} );
