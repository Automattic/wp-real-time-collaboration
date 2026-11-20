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
 * Internal dependencies
 */
import type {
	EntitySyncContext,
	EntitySyncManager,
} from '../../../src/editor/gutenberg-contract';

/*
 * The plugin's startup: what loading the browser script registers, and in
 * which order. A step missing from src/index.ts passes the type check, so
 * this test is what catches it.
 *
 * core-data's registration point is replaced by a stand-in that calls the
 * plugin back at once, as core-data does.
 */

type CreateProvider = ( context: EntitySyncContext ) => EntitySyncManager;

const unregister = jest.fn();
const mockRegisterEntitySyncProvider = jest.fn( ( create: CreateProvider ) => {
	created = create( context );

	return unregister;
} );
let created: EntitySyncManager | undefined;

const context: EntitySyncContext = {
	getSyncConfig: () => undefined,
	recordHandlers: () => ( { onStatusChange: () => {} } ),
	collectionHandlers: () => ( { onStatusChange: () => {} } ),
};

jest.mock(
	'@wordpress/core-data',
	() => ( {
		privateApis: {
			get registerEntitySyncProvider() {
				return mockRegisterEntitySyncProvider;
			},
		},
	} ),
	{ virtual: true }
);
jest.mock( '../../../src/editor/lock-unlock', () => ( {
	unlockCoreData: ( value: unknown ) => value,
	unlockEditor: ( value: unknown ) => value,
} ) );
jest.mock( '@wordpress/blocks', () => ( {
	getBlockType: () => undefined,
	getBlockContent: () => '',
	getSaveContent: () => '',
	parse: () => [],
	serialize: () => '',
	serializeRawBlock: () => '',
} ) );
// Each transport gives a function that connects one room.
jest.mock(
	'../../../src/transports/http-polling/http-polling-provider',
	() => ( { createHttpPollingProvider: () => async () => undefined } )
);
jest.mock( '../../../src/transports/websocket/websocket-provider', () => ( {
	createWebSocketProvider: () => async () => undefined,
} ) );
jest.mock( '../../../src/transports/http-polling/polling-manager', () => ( {
	flushHeldUpdates: jest.fn( async () => {} ),
} ) );
jest.mock( '../../../src/awareness', () => ( {
	bootstrapSlowAwareness: jest.fn(),
} ) );
// The review screens load the editor packages, which this test does not
// need.
jest.mock( '../../../src/review', () => ( {
	registerConflictSource: jest.fn(),
} ) );
jest.mock( '../../../src/review/typing-hold', () => ( {
	TYPING_HOLD_MAX_MS: 20000,
	typingQuietIn: () => 0,
} ) );

type CollaborationWindow = {
	__experimentalEnableRealTimeCollaboration?: boolean;
	_wpCollaborationSync?: Record< string, unknown >;
};

const page = window as CollaborationWindow;

/**
 * Loads the plugin's browser script anew.
 *
 * @return The modules the test looks at, from the same load.
 */
function start() {
	let modules:
		| {
				engines: typeof import('../../../src/registry/engines');
				transports: typeof import('../../../src/registry/transports');
				register: typeof import('../../../src/editor/register');
				review: typeof import('../../../src/review');
				awareness: typeof import('../../../src/awareness');
		  }
		| undefined;

	jest.isolateModules( () => {
		require( '../../../src/index' );
		modules = {
			engines: require( '../../../src/registry/engines' ),
			transports: require( '../../../src/registry/transports' ),
			register: require( '../../../src/editor/register' ),
			review: require( '../../../src/review' ),
			awareness: require( '../../../src/awareness' ),
		};
	} );

	if ( ! modules ) {
		throw new Error( 'The plugin script did not load.' );
	}

	return modules;
}

beforeEach( () => {
	created = undefined;
	page.__experimentalEnableRealTimeCollaboration = true;
	page._wpCollaborationSync = {
		engine: 'intent-log',
		engineProtocol: 3,
		transports: [ 'http-polling', 'websocket' ],
		transportProtocol: 1,
	};
} );

afterEach( () => {
	created?.unloadAll();
	delete page.__experimentalEnableRealTimeCollaboration;
	delete page._wpCollaborationSync;
	jest.clearAllMocks();
} );

describe( 'the plugin’s startup', () => {
	it( 'registers the engine and the transports, then hands the engine’s provider to core-data', () => {
		const { engines, review, awareness } = start();

		expect( Object.keys( engines.getSyncEngines() ) ).toEqual( [
			'intent-log',
		] );
		expect( mockRegisterEntitySyncProvider ).toHaveBeenCalledTimes( 1 );

		// core-data got a provider with the members it calls.
		expect( created ).toEqual(
			expect.objectContaining( {
				load: expect.any( Function ),
				applyEditBatch: expect.any( Function ),
				unload: expect.any( Function ),
				unloadAll: expect.any( Function ),
				undoHistory: expect.any( Object ),
				services: expect.any( Object ),
			} )
		);
		// The review screens show what this engine set aside.
		expect( review.registerConflictSource ).toHaveBeenCalledTimes( 1 );
		expect( awareness.bootstrapSlowAwareness ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'registers both transports', () => {
		page._wpCollaborationSync = {
			engine: 'intent-log',
			engineProtocol: 3,
			transports: [ 'websocket' ],
			transportProtocol: 1,
		};

		const { transports } = start();

		// The announced transport is one the script registered.
		expect( transports.getProviderCreators() ).toHaveLength( 1 );
	} );

	it( 'registers nothing with core-data while collaboration is off', () => {
		page.__experimentalEnableRealTimeCollaboration = false;

		start();

		expect( mockRegisterEntitySyncProvider ).not.toHaveBeenCalled();
	} );

	it( 'registers nothing with core-data when the server announced another engine', () => {
		// The editor then falls back to the post lock by itself.
		page._wpCollaborationSync = {
			engine: 'another-engine',
			engineProtocol: 1,
		};

		start();

		expect( mockRegisterEntitySyncProvider ).not.toHaveBeenCalled();
	} );

	it( 'registers nothing with core-data when the versions of the engine differ', () => {
		page._wpCollaborationSync = {
			engine: 'intent-log',
			engineProtocol: 99,
		};

		start();

		expect( mockRegisterEntitySyncProvider ).not.toHaveBeenCalled();
	} );

	it( 'undoes the registration and stops the provider on cleanup', () => {
		const { register } = start();

		mockRegisterEntitySyncProvider.mockClear();

		const cleanup = register.registerEngineWithEditor();
		const provider = created;
		const unloadAll = provider
			? jest.spyOn( provider, 'unloadAll' )
			: undefined;

		cleanup();

		expect( unregister ).toHaveBeenCalledTimes( 1 );
		expect( unloadAll ).toHaveBeenCalledTimes( 1 );
	} );
} );
