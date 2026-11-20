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
import type { EngineSessionCodec } from '../../../../src/registry/types';

/**
 * The cadence rules of docs/transports.md, with the signaling
 * lane and the advisory channel replaced by controllable fakes.
 */

let mockSignalingAvailable = true;
let mockOthers = false;
let mockCoverage = false;
let mockChannelPresence: Record< string, unknown > = {};
const mockCallbacks: {
	others: Array< ( others: boolean ) => void >;
	coverage: Array< () => void >;
	announce: Array< ( room: string ) => void >;
	presence: Array< ( room: string ) => void >;
	cursor: Array< ( cursor: number ) => void >;
	engine: Array< ( engine: string ) => void >;
} = {
	others: [],
	coverage: [],
	announce: [],
	presence: [],
	cursor: [],
	engine: [],
};
const mockSetSignalCarrier = jest.fn();
const mockAnnounceLocalWrite = jest.fn();

jest.mock( '@wordpress/hooks', () => ( {
	addAction: jest.fn(),
	applyFilters: jest.fn(
		( _hook: string, defaultValue: unknown ) => defaultValue
	),
} ) );

jest.mock( '../../../../src/providers/advisory/signaling', () => ( {
	applyAnswer: jest.fn(),
	buildProbe: () => ( { seq: 1, room: 'postType/post:1', token: 'tok' } ),
	getPresenceRoom: () => 'postType/post:1',
	getPresenceToken: () => 'tok',
	probeFailed: jest.fn(),
	installSignaling: jest.fn(),
	installSignalingLifecycle: jest.fn(),
	isSignalingAvailable: () => mockSignalingAvailable,
	othersPresent: () => mockOthers,
	onOthersChanged: ( cb: ( others: boolean ) => void ) =>
		mockCallbacks.others.push( cb ),
	onRoomCursor: ( cb: ( cursor: number ) => void ) =>
		mockCallbacks.cursor.push( cb ),
	onRoomEngine: ( cb: ( engine: string ) => void ) =>
		mockCallbacks.engine.push( cb ),
	setSignalCarrier: mockSetSignalCarrier,
	setSyncClientId: jest.fn(),
} ) );

jest.mock( '../../../../src/providers/advisory/channel', () => ( {
	advisoryCoversClients: () => mockCoverage,
	getChannelPresence: () => mockChannelPresence,
	onAdvisoryAnnounce: ( cb: ( room: string ) => void ) =>
		mockCallbacks.announce.push( cb ),
	onAdvisoryCoverageChanged: ( cb: () => void ) =>
		mockCallbacks.coverage.push( cb ),
	onAdvisoryPresence: ( cb: ( room: string ) => void ) =>
		mockCallbacks.presence.push( cb ),
	setPresenceSource: jest.fn(),
	startAdvisoryChannel: jest.fn(),
	stopAdvisoryChannel: jest.fn(),
} ) );

jest.mock( '../../../../src/providers/advisory/announce', () => ( {
	announceLocalWrite: mockAnnounceLocalWrite,
} ) );

jest.mock( '../../../../src/providers/http-polling/utils', () => ( {
	...( jest.requireActual(
		'../../../../src/providers/http-polling/utils'
	) as object ),
	postSyncUpdate: jest.fn(),
	postSyncUpdateNonBlocking: jest.fn(),
} ) );

type Manager =
	typeof import('../../../../src/providers/http-polling/polling-manager');

function response( clients: number[], cursor = 1 ) {
	const awareness: Record< number, object > = {};
	for ( const id of clients ) {
		awareness[ id ] = { user: id };
	}
	return {
		rooms: [
			{ room: 'test-room', end_cursor: cursor, awareness, updates: [] },
		],
	};
}

/**
 * A stand-in session, as a transport sees one. It holds the updates that
 * wait and hands them out when asked.
 *
 * @param clientId The client id the session announces.
 */
function createMockSession( clientId = 1 ) {
	let waiting: unknown[] = [];
	let onTheirWay: unknown[] = [];
	let listener: ( ( size: number ) => void ) | null = null;

	return {
		applyRemoteAwareness: jest.fn(),
		clientId,
		engineSlug: 'intent-log',
		destroy: jest.fn(),
		getLocalAwareness: jest.fn( () => ( { user: clientId } ) ),
		onWorkWaiting: jest.fn( ( callback: ( size: number ) => void ) => {
			listener = callback;
		} ),
		hasUpdatesToSend: jest.fn( () => waiting.length > 0 ),
		takeUpdatesToSend: jest.fn( () => {
			const taken = waiting;

			waiting = [];
			onTheirWay.push( ...taken );

			return taken;
		} ),
		connectionLost: jest.fn( () => {
			waiting = [ ...onTheirWay, ...waiting ];
			onTheirWay = [];
		} ),
		// An answer from the server settles what was on its way.
		receiveUpdates: jest.fn( () => {
			onTheirWay = [];
		} ),
		// What a local edit does: the update waits, and the transport
		// is told.
		addUpdate( update: unknown, size: number ) {
			waiting.push( update );
			listener?.( size );
		},
	};
}

describe( 'polling-manager cadence', () => {
	let pollingManager: Manager[ 'pollingManager' ];
	let flushUpdatesNow: Manager[ 'flushUpdatesNow' ];
	let mockApplyAnswer: jest.Mock;
	let mockPostSyncUpdate: jest.Mock<
		typeof import('../../../../src/providers/http-polling/utils').postSyncUpdate
	>;

	beforeEach( () => {
		jest.useFakeTimers();
		mockSignalingAvailable = true;
		mockOthers = false;
		mockCoverage = false;
		mockChannelPresence = {};
		mockCallbacks.others.length = 0;
		mockCallbacks.coverage.length = 0;
		mockCallbacks.announce.length = 0;
		mockCallbacks.presence.length = 0;
		mockCallbacks.cursor.length = 0;
		mockCallbacks.engine.length = 0;
		mockSetSignalCarrier.mockClear();
		mockAnnounceLocalWrite.mockClear();
		jest.isolateModules( () => {
			const managerModule: Manager = require( '../../../../src/providers/http-polling/polling-manager' );
			pollingManager = managerModule.pollingManager;
			flushUpdatesNow = managerModule.flushUpdatesNow;
			mockPostSyncUpdate =
				require( '../../../../src/providers/http-polling/utils' ).postSyncUpdate;
			// The manager's own copy of the signaling module.
			mockApplyAnswer =
				require( '../../../../src/providers/advisory/signaling' ).applyAnswer;
			mockApplyAnswer.mockReset();
		} );
	} );

	afterEach( () => {
		// Each test gets a fresh module, but the document is shared: drop
		// the rooms so the module's visibilitychange listener goes with
		// them, or a later test's dispatch would poll through every earlier
		// module too.
		for ( const room of [ 'test-room', 'test-room-2' ] ) {
			pollingManager.unregisterRoom( room, {
				sendDisconnectSignal: false,
			} );
		}
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	function register( session = createMockSession() ) {
		pollingManager.registerRoom( {
			room: 'test-room',
			session: session as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		return session;
	}

	it( 'a lone tab keeps the solo cadence for a discovery window after load, then stops scheduling', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		// 30 s of 4 s polls: the moments a second person most often turns
		// up, found within seconds instead of a heartbeat.
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		// Past the window (plus the last 4 s poll scheduled inside it):
		// no timer at all.
		await jest.advanceTimersByTimeAsync( 30000 );
		const afterWindow = mockPostSyncUpdate.mock.calls.length;
		expect( afterWindow ).toBeGreaterThanOrEqual( 8 );
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterWindow );

		// Regaining focus reopens the window.
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		await jest.advanceTimersByTimeAsync( 0 );
		const afterFocus = mockPostSyncUpdate.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterFocus + 1 );
	} );

	it( 'a lone tab sends its edits once per polling interval, and a flush (before a save) sends at once', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		// Nobody is reading, so no request is made for them yet.
		await jest.advanceTimersByTimeAsync( 3900 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// One polling interval after the last request, one request
		// carries both.
		await jest.advanceTimersByTimeAsync( 100 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 2 );
		expect( mockAnnounceLocalWrite ).toHaveBeenCalledWith( 'test-room' );

		// The save's flush does not wait for the interval. It resolves
		// when the request has returned.
		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		const flushed = flushUpdatesNow();
		await jest.advanceTimersByTimeAsync( 0 );
		await flushed;
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		expect(
			mockPostSyncUpdate.mock.calls[ 2 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'a lone tab past the discovery window still sends its edits within one polling interval', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 60000 );
		const quiet = mockPostSyncUpdate.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 60000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( quiet );

		// The last request was long ago, so the edit goes out after the
		// short delay that lets a burst pile in.
		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( quiet + 1 );

		// Typing goes on: the next request waits a whole interval.
		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 3900 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( quiet + 1 );
		await jest.advanceTimersByTimeAsync( 100 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( quiet + 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ quiet + 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'a lone tab that types without a pause makes one request per polling interval, not two', async () => {
		// The server takes 150 ms to answer, so keys are typed while a
		// request is on its way.
		mockPostSyncUpdate.mockImplementation(
			() =>
				new Promise( ( resolve ) => {
					setTimeout( () => resolve( response( [ 1 ] ) ), 150 );
				} )
		);
		const session = register();
		await jest.advanceTimersByTimeAsync( 60000 );
		const quiet = mockPostSyncUpdate.mock.calls.length;

		// A key every 100 ms for 20 seconds.
		for ( let key = 0; key < 200; key++ ) {
			session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
			await jest.advanceTimersByTimeAsync( 100 );
		}

		const made = mockPostSyncUpdate.mock.calls.length - quiet;
		expect( made ).toBeGreaterThanOrEqual( 5 );
		expect( made ).toBeLessThanOrEqual( 6 );
	} );

	it( 'a flush that lands while a poll is in flight waits for the successor that carries the work', async () => {
		let release!: ( value: ReturnType< typeof response > ) => void;
		mockPostSyncUpdate.mockResolvedValueOnce( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );

		// A poll is in flight: hold it open.
		mockPostSyncUpdate.mockImplementationOnce(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

		// An edit made now was not in that request.
		session.addUpdate( { type: 'update', data: 'AA==' }, 1 );
		let flushed = false;
		void flushUpdatesNow().then( () => {
			flushed = true;
		} );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ], 2 ) );
		release( response( [ 1 ] ) );
		await jest.advanceTimersByTimeAsync( 0 );
		// Not resolved by the in-flight poll's end...
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 0 );
		// ...but by the successor, which carried the edit.
		expect( flushed ).toBe( true );
		expect(
			mockPostSyncUpdate.mock.calls[ 2 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'a lone tab going hidden sends its unsent work once, unless a pagehide follows', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.addUpdate;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );

		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		// A reload hides first, then unloads: pagehide cancels the flush.
		window.dispatchEvent( new Event( 'pagehide' ) );
		await jest.advanceTimersByTimeAsync( 2000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// A real tab switch: the flush lands after the grace period.
		document.dispatchEvent( new Event( 'visibilitychange' ) );
		await jest.advanceTimersByTimeAsync( 1500 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
	} );

	it( 'a wake-up does not shorten the wait after a failed request, so an offline tab does not race to the lost-connection dialog', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		const onStatusChange = jest.fn();
		pollingManager.registerRoom( {
			room: 'test-room',
			session: createMockSession() as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange,
		} );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// The network goes away: every request from here on fails.
		mockPostSyncUpdate.mockRejectedValue( new Error( 'offline' ) );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );

		// The channel between tabs starts a handshake and queues its
		// messages, many a second. Each one asks the loop to poll now.
		const carrier = mockSetSignalCarrier.mock
			.calls[ 0 ][ 0 ] as () => boolean;
		for ( let message = 0; message < 20; message++ ) {
			carrier();
			await jest.advanceTimersByTimeAsync( 40 );
		}

		// 800 ms later: still inside the first wait (1 second), so no
		// request went out and the dialog's condition is not met.
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect( onStatusChange ).not.toHaveBeenCalledWith(
			expect.objectContaining( { backgroundRetriesFailed: true } )
		);

		// The wait ends and one retry goes out.
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'company from the heartbeat wakes a lone tab onto the timer cadence', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.addUpdate;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 3000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		mockOthers = true;
		mockCallbacks.others.forEach( ( cb ) => cb( true ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
		// Nobody on the channel yet: the with-collaborators cadence.
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

		// The heartbeat says they left: back to the solo cadence (the
		// discovery window is still open this soon after load).
		mockOthers = false;
		mockCallbacks.others.forEach( ( cb ) => cb( false ) );
		await jest.advanceTimersByTimeAsync( 3000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'an awareness map with company keeps the timer cadence even when the heartbeat is silent', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'full channel coverage stops the timer and polls on announcements', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		// (Two rounds follow: count from here.)
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 300 );

		// A burst of announcements collapses into one poll after the
		// coalescing delay.
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		// Another right away waits out the floor.
		mockCallbacks.announce.forEach( ( cb ) => cb( 'test-room' ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
		await jest.advanceTimersByTimeAsync( 100 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
	} );

	it( 'a local update under coverage polls on demand', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.addUpdate;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'a coverage flip never parks queued updates behind a stopped timer', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		// On the 1 s timer; an undo queues inverse intents, which the
		// pending timer would send.
		const onLocalUpdate = session.addUpdate;
		onLocalUpdate( { type: 'intent', data: 'AA==' }, 1 );
		// The channel connects right then: coverage flips and the timer
		// is re-evaluated. The queued work must still go out promptly.
		mockCoverage = true;
		mockCallbacks.coverage.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].updates
		).toHaveLength( 1 );
	} );

	it( 'updates queued during a poll under coverage go out right after it', async () => {
		let release!: ( value: ReturnType< typeof response > ) => void;
		mockOthers = true;
		mockCoverage = true;
		mockPostSyncUpdate.mockImplementationOnce(
			() =>
				new Promise( ( resolve ) => {
					release = resolve;
				} )
		);
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		const onLocalUpdate = session.addUpdate;
		onLocalUpdate( { type: 'update', data: 'AA==' }, 1 );
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 2 ) );
		release( response( [ 1, 2 ] ) );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'a room registered mid-session polls soon even with the timer stopped', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		pollingManager.registerRoom( {
			room: 'taxonomy/category',
			session: createMockSession( 3 ) as unknown as EngineSessionCodec,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		await jest.advanceTimersByTimeAsync( 300 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect(
			mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms.map( ( r ) => r.room )
		).toEqual( [ 'test-room', 'taxonomy/category' ] );
	} );

	it( 'a heartbeat answer reporting the room ahead of this tab polls, one that does not stays quiet', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 7 ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// Same head as our cursor: nothing to fetch.
		mockCallbacks.cursor.forEach( ( cb ) => cb( 7 ) );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// A script wrote rows nobody announced: the beat says the room
		// is ahead, so the tab polls.
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 9 ) );
		mockCallbacks.cursor.forEach( ( cb ) => cb( 9 ) );
		await jest.advanceTimersByTimeAsync( 150 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		expect( mockPostSyncUpdate.mock.calls[ 1 ][ 0 ].rooms[ 0 ].after ).toBe(
			7
		);
	} );

	it( 'the answer that rides a poll and names the rows that same poll brought does not cause a second poll', async () => {
		mockOthers = true;
		mockCoverage = true;
		// The server stored this tab's edit as row 9, and says so twice:
		// in the room's answer and in the signaling answer beside it.
		mockApplyAnswer.mockImplementation( () =>
			mockCallbacks.cursor.forEach( ( cb ) => cb( 9 ) )
		);
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 9 ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'the answer that rides a poll and names a row that poll did not bring causes another poll', async () => {
		mockOthers = true;
		mockCoverage = true;
		// Row 12 was stored right after the server read the rows for
		// this answer, which end at row 9.
		mockApplyAnswer.mockImplementationOnce( () =>
			mockCallbacks.cursor.forEach( ( cb ) => cb( 12 ) )
		);
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ], 9 ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		await jest.advanceTimersByTimeAsync( 500 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'a heartbeat answer naming a different engine polls into the fence; the same engine stays quiet', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		mockCallbacks.engine.forEach( ( cb ) => cb( 'intent-log' ) );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		mockCallbacks.engine.forEach( ( cb ) => cb( 'yjs-server' ) );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'losing coverage restarts the stopped loop at the with-collaborators cadence', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockOthers = true;
		mockCoverage = true;
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 5000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		mockCoverage = false;
		mockCallbacks.coverage.forEach( ( cb ) => cb() );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'without the signaling lane the always-on cadence is unchanged', async () => {
		mockSignalingAvailable = false;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
	} );

	function setVisibility( state: 'hidden' | 'visible' ) {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => state,
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
	}

	it( 'a hidden tab with company polls at the background cadence; visible again polls at once', async () => {
		mockOthers = true;
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// Hidden: the timer already pending fires, and the polls after it
		// are 25 s apart.
		setVisibility( 'hidden' );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 24999 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 1 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 3 );

		// Visible again: one poll at once, then the collaborator interval.
		setVisibility( 'visible' );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 4 );
		await jest.advanceTimersByTimeAsync( 1000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 5 );
	} );

	it( 'a tab hidden while alone polls through the discovery window, then goes quiet', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1 ] ) );
		register();
		await jest.advanceTimersByTimeAsync( 0 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );

		// Alone inside the discovery window is the solo interval, hidden
		// or not. Past it there is no timer at all.
		setVisibility( 'hidden' );
		await jest.advanceTimersByTimeAsync( 4000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 2 );
		await jest.advanceTimersByTimeAsync( 30000 );
		const afterWindow = mockPostSyncUpdate.mock.calls.length;
		await jest.advanceTimersByTimeAsync( 120000 );
		expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( afterWindow );
	} );

	it( 'overlays channel presence on the poll response and re-applies it when it changes', async () => {
		mockPostSyncUpdate.mockResolvedValue( response( [ 1, 2 ] ) );
		mockChannelPresence = { 2: { name: 'live' }, 3: { name: 'new' } };
		const session = register();
		await jest.advanceTimersByTimeAsync( 0 );
		// The channel's base presence overlays the server's copy per
		// client (server-only fields such as cursors survive), and a peer
		// the server has not reported yet appears from the channel alone.
		expect( session.applyRemoteAwareness ).toHaveBeenLastCalledWith( {
			1: { user: 1 },
			2: { user: 2, name: 'live' },
			3: { name: 'new' },
		} );

		mockChannelPresence = { 2: { name: 'renamed' } };
		mockCallbacks.presence.forEach( ( cb ) => cb( 'test-room' ) );
		expect( session.applyRemoteAwareness ).toHaveBeenLastCalledWith( {
			1: { user: 1 },
			2: { user: 2, name: 'renamed' },
		} );
	} );

	describe( 'handing a room to and from a preferred transport', () => {
		it( 'resumes at the given cursor and releases the room with its cursor, leaving unsent work with the session', async () => {
			mockSignalingAvailable = false;
			mockPostSyncUpdate.mockResolvedValue( response( [ 1 ], 9 ) );
			const session = createMockSession();
			pollingManager.registerRoom( {
				room: 'test-room',
				session: session as unknown as EngineSessionCodec,
				log: jest.fn(),
				onStatusChange: jest.fn(),
				initialCursor: 5,
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			expect(
				mockPostSyncUpdate.mock.calls[ 0 ][ 0 ].rooms[ 0 ].after
			).toBe( 5 );
			session.addUpdate( { type: 'update', data: 'AA==' }, 1 );

			const released = await pollingManager.releaseRoom( 'test-room' );
			expect( released ).toEqual( { cursor: 9 } );
			expect( session.hasUpdatesToSend() ).toBe( true );
			expect( session.destroy ).not.toHaveBeenCalled();
			// The loop is empty: nothing polls any more.
			await jest.advanceTimersByTimeAsync( 10000 );
			expect( mockPostSyncUpdate ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'waits for a request in flight before releasing, so the cursor is final', async () => {
			mockSignalingAvailable = false;
			let release!: ( value: ReturnType< typeof response > ) => void;
			mockPostSyncUpdate.mockImplementationOnce(
				() =>
					new Promise( ( resolve ) => {
						release = resolve;
					} )
			);
			register();
			await jest.advanceTimersByTimeAsync( 0 );
			let released: unknown = null;
			void pollingManager.releaseRoom( 'test-room' ).then( ( value ) => {
				released = value;
			} );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( released ).toBeNull();
			release( response( [ 1 ], 3 ) );
			await jest.advanceTimersByTimeAsync( 0 );
			expect( released ).toEqual( { cursor: 3 } );
		} );
	} );
} );
