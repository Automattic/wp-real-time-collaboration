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
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import {
	websocketManager,
	resetWebSocketManagerForTesting,
} from '../../../src/providers/websocket/websocket-manager';
import { postSyncUpdate } from '../../../src/providers/http-polling/utils';
import type {
	SyncPayload,
	SyncResponse,
	SyncUpdate,
} from '../../../src/providers/http-polling/types';
import {
	createIntentLogSession,
	INTENT_LOG_UPDATE_TYPES,
} from '../../../src/engines/intent-log-session';
import { createDocument } from '../../../src/engines/intent-log/document.js';

/*
 * Known defect, plan section "State in the browser" (the paragraph that
 * starts "One defect the single queue fixes by design").
 *
 * An open WebSocket has no queue. An edit is written to the socket once
 * (sendUpdate in src/providers/websocket/websocket-manager.ts). If the
 * socket closes before the server reads the edit, nothing sends it again:
 * the fallback to polling starts with an empty queue, and so does the
 * next socket. The edit stays on the person's screen but never reaches
 * the server or anyone else.
 */

// The token request for the socket is the only call that goes through
// api-fetch here. The polling requests go through the two mocks below.
jest.mock( '@wordpress/api-fetch' );
jest.mock( '../../../src/providers/http-polling/utils', () => ( {
	...( jest.requireActual(
		'../../../src/providers/http-polling/utils'
	) as object ),
	postSyncUpdate: jest.fn(),
	postSyncUpdateNonBlocking: jest.fn(),
} ) );

const mockApiFetch = jest.mocked( apiFetch );
const mockPostSyncUpdate = jest.mocked( postSyncUpdate );

const ROOM = 'postType/post:1';

/** A stand-in socket that records what is sent and can be opened or closed. */
class FakeWebSocket {
	public static instances: FakeWebSocket[] = [];
	public static OPEN = 1;
	public readyState = 0;
	public sent: string[] = [];
	private listeners = new Map< string, Array< ( event: object ) => void > >();

	public constructor( public url: string ) {
		FakeWebSocket.instances.push( this );
	}

	public addEventListener(
		type: string,
		listener: ( event: object ) => void
	): void {
		this.listeners.set( type, [
			...( this.listeners.get( type ) ?? [] ),
			listener,
		] );
	}

	public send( data: string ): void {
		this.sent.push( data );
	}

	public close(): void {
		this.readyState = 3;
		this.emit( 'close', {} );
	}

	public open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit( 'open', {} );
	}

	public receive( frame: object ): void {
		this.emit( 'message', { data: JSON.stringify( frame ) } );
	}

	private emit( type: string, event: object ): void {
		for ( const listener of this.listeners.get( type ) ?? [] ) {
			listener( event );
		}
	}
}

/**
 * The edits a socket was asked to carry, across all its frames.
 *
 * @param socket The stand-in socket.
 * @return The updates.
 */
function updatesSentOn( socket: FakeWebSocket ): SyncUpdate[] {
	return socket.sent.flatMap( ( frame ) => {
		const parsed: { rooms: Array< { updates: SyncUpdate[] } > } =
			JSON.parse( frame );
		return parsed.rooms.flatMap( ( room ) => room.updates );
	} );
}

/**
 * The newest stand-in socket.
 *
 * @return The socket.
 */
function latestSocket(): FakeWebSocket {
	const socket = FakeWebSocket.instances.at( -1 );
	if ( ! socket ) {
		throw new Error( 'No socket was opened.' );
	}

	return socket;
}

describe( 'known defect: an edit sent on a WebSocket that dies before the server reads it', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		Object.assign( window, {
			WebSocket: FakeWebSocket,
			_wpCollaborationTransportConfig: {
				websocket: { url: 'ws://localhost:8787' },
			},
		} );
		mockApiFetch.mockResolvedValue( { token: 't0ken' } );
		// The polling server has nothing new and answers no edit.
		mockPostSyncUpdate.mockImplementation(
			async ( payload: SyncPayload ): Promise< SyncResponse > => ( {
				rooms: payload.rooms.map( ( room ) => ( {
					room: room.room,
					end_cursor: room.after,
					awareness: {},
					updates: [],
				} ) ),
			} )
		);
	} );

	afterEach( () => {
		websocketManager.unregisterRoom( ROOM );
		resetWebSocketManagerForTesting();
		FakeWebSocket.instances = [];
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	it.failing(
		'sends an unanswered edit again after the socket closes (known defect, fixed in Phase 5)',
		async () => {
			const session = createIntentLogSession( {
				userId: 1,
				clientId: 11,
			} );
			websocketManager.registerRoom( {
				room: ROOM,
				session,
				onStatusChange: jest.fn(),
			} );
			await jest.advanceTimersByTimeAsync( 0 );

			// The socket opens and the server sends the document.
			const firstSocket = latestSocket();
			firstSocket.open();
			firstSocket.receive( {
				type: 'sync',
				rooms: [
					{
						room: ROOM,
						awareness: {},
						updates: [
							{
								data: JSON.stringify( {
									doc: createDocument( [
										{
											syncId: 'p1',
											blockType: 'core/paragraph',
											text: 'Hello',
										},
									] ),
								} ),
								type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
							},
						],
						end_cursor: 1,
					},
				],
			} );

			// The person types. The edit is written to the open socket.
			const edit = session.author( 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: 5,
				text: ' world',
			} );
			const carriesTheEdit = ( update: SyncUpdate ) =>
				update.data.includes( edit.intentId );
			expect( updatesSentOn( firstSocket ).some( carriesTheEdit ) ).toBe(
				true
			);

			// The socket dies before the server reads the edit, so no
			// answer ever arrives. Polling takes the room over at once.
			firstSocket.close();
			await jest.advanceTimersByTimeAsync( 900 );
			expect( session.getPendingCount() ).toBe( 1 );

			// One second after the close, the socket comes back and takes
			// the room back from polling.
			await jest.advanceTimersByTimeAsync( 100 );
			const secondSocket = latestSocket();
			expect( secondSocket ).not.toBe( firstSocket );
			secondSocket.open();
			await jest.advanceTimersByTimeAsync( 30000 );

			// Both routes were used after the close, and one of them
			// carried the edit again.
			const sentAfterTheClose = [
				...mockPostSyncUpdate.mock.calls.flatMap( ( [ payload ] ) =>
					payload.rooms.flatMap( ( room ) => room.updates )
				),
				...updatesSentOn( secondSocket ),
			];
			expect( mockPostSyncUpdate ).toHaveBeenCalled();
			expect( secondSocket.sent.length ).toBeGreaterThan( 0 );
			expect( sentAfterTheClose.some( carriesTheEdit ) ).toBe( true );
		}
	);
} );
