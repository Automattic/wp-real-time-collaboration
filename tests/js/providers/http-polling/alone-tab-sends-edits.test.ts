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
import { pollingManager } from '../../../../src/providers/http-polling/polling-manager';
import { POLLING_INTERVAL_IN_MS } from '../../../../src/providers/http-polling/config';
import { postSyncUpdate } from '../../../../src/providers/http-polling/utils';
import type {
	SyncPayload,
	SyncResponse,
	SyncUpdate,
} from '../../../../src/providers/http-polling/types';
import {
	isSignalingAvailable,
	othersPresent,
	resetSignalingForTesting,
} from '../../../../src/providers/advisory/signaling';
import {
	createIntentLogSession,
	INTENT_LOG_UPDATE_TYPES,
} from '../../../../src/engines/intent-log-session';
import { createDocument } from '../../../../src/engines/intent-log/document.js';

/*
 * A tab that is alone in its post still sends its edits, at most once per
 * polling interval. The server then has them, so a reload or a crash
 * loses one interval of typing at most.
 */

jest.mock( '../../../../src/providers/http-polling/utils', () => ( {
	...( jest.requireActual(
		'../../../../src/providers/http-polling/utils'
	) as object ),
	postSyncUpdate: jest.fn(),
	postSyncUpdateNonBlocking: jest.fn(),
} ) );

const mockPostSyncUpdate = jest.mocked( postSyncUpdate );

const ROOM = 'postType/post:1';
const CLIENT_ID = 11;

describe( 'a tab editing alone', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		// What the server prints on a post's editor screen, plus the
		// WordPress heartbeat. Together they tell the tab whether anyone
		// else is in the post. Nobody else is.
		Object.assign( window, {
			_wpRtcSettings: {
				advisory: { room: ROOM, token: 'tab-token' },
			},
			wp: { heartbeat: { interval: jest.fn() } },
		} );
		resetSignalingForTesting();

		// The server: the first answer carries the document, and every
		// answer lists this tab as the only one in the room.
		mockPostSyncUpdate.mockImplementation(
			async ( payload: SyncPayload ): Promise< SyncResponse > => ( {
				rooms: payload.rooms.map( ( room ) => {
					const updates: SyncUpdate[] = [];
					if ( 0 === room.after ) {
						updates.push( {
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
						} );
					}

					return {
						room: room.room,
						end_cursor: 1,
						awareness: { [ CLIENT_ID ]: {} },
						updates,
					};
				} ),
			} )
		);
	} );

	afterEach( () => {
		pollingManager.unregisterRoom( ROOM, { sendDisconnectSignal: false } );
		resetSignalingForTesting();
		Object.assign( window, {
			_wpRtcSettings: undefined,
			wp: undefined,
		} );
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	it( 'sends its edits within a normal poll interval', async () => {
		expect( isSignalingAvailable() ).toBe( true );
		expect( othersPresent() ).toBe( false );

		const session = createIntentLogSession( {
			userId: 1,
			clientId: CLIENT_ID,
		} );
		pollingManager.registerRoom( {
			room: ROOM,
			session,
			log: jest.fn(),
			onStatusChange: jest.fn(),
		} );
		await jest.advanceTimersByTimeAsync( 0 );
		expect( session.isInitialized() ).toBe( true );

		// The person types while nobody else is in the post.
		const edit = session.author( 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 5,
			text: ' world',
		} );
		const requestsBefore = mockPostSyncUpdate.mock.calls.length;

		// Two poll intervals pass. The tab still polls on its timer
		// here, because it does so for 30 seconds after the page loads.
		await jest.advanceTimersByTimeAsync( 2 * POLLING_INTERVAL_IN_MS );
		const requests = mockPostSyncUpdate.mock.calls.slice( requestsBefore );
		expect( requests.length ).toBeGreaterThanOrEqual( 2 );

		// One of those requests carried the edit to the server.
		const sent = requests.flatMap( ( [ payload ] ) =>
			payload.rooms.flatMap( ( room ) => room.updates )
		);
		expect(
			sent.some( ( update ) => update.data.includes( edit.intentId ) )
		).toBe( true );
	} );
} );
