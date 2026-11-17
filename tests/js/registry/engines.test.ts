/**
 * External dependencies
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

/**
 * WordPress dependencies
 */
import { addFilter, removeFilter } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import type { EntitySyncManager } from '../../../src/editor/gutenberg-contract';
import {
	getSyncEngines,
	registerSyncEngine,
	resetSyncEnginesForTesting,
	resolveSyncEngine,
	type SyncEngineRegistration,
} from '../../../src/registry/engines';

const provider: EntitySyncManager = {
	load: () => {},
	applyEditBatch: () => {},
	unload: () => {},
	unloadAll: () => {},
};

const engine = (
	slug: string,
	protocolVersion: number
): SyncEngineRegistration => ( {
	slug,
	protocolVersion,
	createProvider: () => provider,
} );

const announce = ( value: unknown ) => {
	( window as { _wpCollaborationSync?: unknown } )._wpCollaborationSync =
		value;
};

describe( 'the engine registry', () => {
	beforeEach( () => {
		resetSyncEnginesForTesting();
	} );

	afterEach( () => {
		announce( undefined );
	} );

	it( 'picks the engine the server announced', () => {
		registerSyncEngine( engine( 'intent-log', 2 ) );
		announce( { engine: 'intent-log', engineProtocol: 2 } );

		expect( resolveSyncEngine()?.slug ).toBe( 'intent-log' );
	} );

	it( 'picks nothing when the server announced no engine', () => {
		registerSyncEngine( engine( 'intent-log', 2 ) );

		expect( resolveSyncEngine() ).toBeNull();
	} );

	it( 'picks nothing when the browser does not have the announced engine', () => {
		registerSyncEngine( engine( 'intent-log', 2 ) );
		announce( { engine: 'another-engine', engineProtocol: 1 } );

		expect( resolveSyncEngine() ).toBeNull();
	} );

	it( 'picks nothing when the protocol versions differ', () => {
		registerSyncEngine( engine( 'intent-log', 2 ) );
		announce( { engine: 'intent-log', engineProtocol: 3 } );

		expect( resolveSyncEngine() ).toBeNull();
	} );

	it( 'lets a later registration of the same slug win', () => {
		registerSyncEngine( engine( 'intent-log', 1 ) );
		registerSyncEngine( engine( 'intent-log', 2 ) );

		expect( getSyncEngines()[ 'intent-log' ].protocolVersion ).toBe( 2 );
	} );

	it( 'lets other code add an engine through the sync.engines filter', () => {
		const namespace = 'wp-real-time-collaboration/engines-test';

		addFilter( 'sync.engines', namespace, ( engines: unknown[] ) => [
			...engines,
			engine( 'from-a-filter', 1 ),
			{ slug: 'not-an-engine' },
		] );

		expect( Object.keys( getSyncEngines() ) ).toEqual( [
			'from-a-filter',
		] );

		removeFilter( 'sync.engines', namespace );
	} );
} );
