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
import {
	createReplica,
	INTENT_LOG_UPDATE_TYPES,
	RESET_WAIT_LIMIT_MS,
	type Replica,
	type SettledDisposition,
	type StaleBaseRecovery,
} from '../../../src/replica/replica';
import { createDocument } from '../../../src/engines/intent-log/document.js';
import { createIntent } from '../../../src/engines/intent-log/intents.js';
import type { EngineUpdate } from '../../../src/registry/types';
import { contentText } from '../known-defects/helpers';

/*
 * One room's state in the browser: what each event does in each state.
 * The states are no document, in step, waiting and reset waiting (see
 * src/replica/replica.ts).
 */

const ACTOR = 'u1c11';
const NO_LIMIT = { maxBytes: Infinity };

/**
 * A whole copy of the document, as the server sends it.
 *
 * @param text The paragraph's text.
 * @param seq  The copy's position. Left out for the room's first document.
 * @return The row.
 */
function copy( text: string, seq?: number ): EngineUpdate {
	return {
		data: JSON.stringify( {
			doc: createDocument( [
				{ syncId: 'p1', blockType: 'core/paragraph', text },
			] ),
			seq,
		} ),
		type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
	};
}

/**
 * Another person's accepted edit: text put at the start of the paragraph.
 *
 * @param id      The edit's id.
 * @param seq     The room's position after it.
 * @param baseSeq The position it was made at.
 * @return The row.
 */
function otherEdit( id: string, seq: number, baseSeq = seq - 1 ): EngineUpdate {
	return {
		data: JSON.stringify( {
			...createIntent(
				'insert_text',
				{ syncId: 'p1', field: 'content', offset: 0, text: `${ id } ` },
				{ actorId: 'u2c22', baseSeq, intentId: id }
			),
			seq,
		} ),
		type: INTENT_LOG_UPDATE_TYPES.INTENT,
	};
}

/**
 * A replica with everything it reports written down.
 *
 * @return The replica and what it reported.
 */
function setUp() {
	const seen = {
		changes: 0,
		workWaiting: 0,
		resets: 0,
		acceptedRuns: [] as number[],
		settled: [] as SettledDisposition[],
		recoveries: [] as StaleBaseRecovery[],
	};
	const replica: Replica = createReplica( ACTOR, {
		change: () => seen.changes++,
		workWaiting: () => seen.workWaiting++,
		acceptedRows: ( rows ) => seen.acceptedRuns.push( rows.length ),
		settled: ( settled ) => seen.settled.push( settled ),
		proposal: () => {},
		proposalsChange: () => {},
		reset: () => seen.resets++,
		recovery: ( recovery ) => seen.recoveries.push( recovery ),
	} );

	return { replica, seen };
}

/**
 * The person types at the end of the paragraph.
 *
 * @param replica The replica.
 * @param text    The text.
 * @return The edit.
 */
function type( replica: Replica, text: string ) {
	const doc = replica.getClient()?.doc;

	if ( ! doc ) {
		throw new Error( 'The replica has no document.' );
	}

	return replica.author( 'insert_text', {
		syncId: 'p1',
		field: 'content',
		offset: contentText( doc, 'p1' ).length,
		text,
	} );
}

/**
 * The paragraph's text as the person sees it.
 *
 * @param replica The replica.
 * @return The text.
 */
function shownText( replica: Replica ): string {
	const doc = replica.getClient()?.doc;

	if ( ! doc ) {
		throw new Error( 'The replica has no document.' );
	}

	return contentText( doc, 'p1' );
}

/**
 * The marks of the outgoing list, in order.
 *
 * @param replica The replica.
 * @return The marks.
 */
function marks( replica: Replica ): string[] {
	return replica.getOutgoing().map( ( entry ) => entry.mark );
}

describe( 'the replica of one room', () => {
	beforeEach( () => {
		jest.useFakeTimers();
	} );

	afterEach( () => {
		jest.clearAllTimers();
		jest.useRealTimers();
	} );

	describe( 'the first document', () => {
		it( 'starts the replica, and a repeated copy changes nothing', () => {
			const { replica } = setUp();

			expect( replica.getState() ).toBe( 'no-document' );
			replica.receive( [ copy( 'Hello' ) ] );
			expect( replica.getState() ).toBe( 'in-step' );

			replica.receive( [ copy( 'Other' ) ] );
			expect( shownText( replica ) ).toBe( 'Hello' );
		} );

		it( 'is needed before the person can edit', () => {
			const { replica } = setUp();

			expect( () =>
				replica.author( 'insert_text', {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'x',
				} )
			).toThrow();
			expect( replica.takeToSend( NO_LIMIT ) ).toEqual( [] );
		} );
	} );

	describe( 'an edit by the person', () => {
		it( 'shows at once, joins the list as not sent, and is announced', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, '!' );

			expect( shownText( replica ) ).toBe( 'Hello!' );
			expect( replica.getState() ).toBe( 'waiting' );
			expect( marks( replica ) ).toEqual( [ 'not-sent' ] );
			expect( seen.workWaiting ).toBe( 1 );
		} );
	} );

	describe( 'what a transport is given to send', () => {
		it( 'is everything not on its way, oldest first, and each update once', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			expect( replica.takeToSend( NO_LIMIT ) ).toEqual( [] );

			const first = type( replica, 'a' );
			const second = type( replica, 'b' );
			const sent = replica.takeToSend( NO_LIMIT );

			expect(
				sent.map( ( update ) => JSON.parse( update.data ).intentId )
			).toEqual( [ first.intentId, second.intentId ] );
			expect( marks( replica ) ).toEqual( [ 'in-flight', 'in-flight' ] );
			expect( replica.hasWorkToSend() ).toBe( false );
			expect( replica.takeToSend( NO_LIMIT ) ).toEqual( [] );
		} );

		it( 'stays within the size it is given, and keeps the order', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, 'a' );
			type( replica, 'b' );

			const [ first ] = replica.takeToSend( NO_LIMIT );
			const size =
				new TextEncoder().encode( JSON.stringify( first ) ).length + 1;

			replica.connectionLost();

			expect( replica.takeToSend( { maxBytes: size - 1 } ) ).toEqual(
				[]
			);
			expect( replica.takeToSend( { maxBytes: size } ) ).toHaveLength(
				1
			);
			expect( marks( replica ) ).toEqual( [ 'in-flight', 'send-again' ] );
		} );
	} );

	describe( 'rows from the server', () => {
		it( 'takes a run of edits in one step', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, '!' );

			const changesBefore = seen.changes;

			replica.receive( [
				otherEdit( 'a', 1 ),
				otherEdit( 'b', 2 ),
				otherEdit( 'c', 3 ),
			] );

			expect( seen.acceptedRuns ).toEqual( [ 3 ] );
			expect( seen.changes ).toBe( changesBefore + 1 );
			expect( shownText( replica ) ).toBe( 'c b a Hello!' );
			expect( replica.getClient()?.cursor ).toBe( 3 );
		} );

		it( 'skips a row it has already, also inside one answer', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			replica.receive( [ otherEdit( 'a', 1 ) ] );
			replica.receive( [ otherEdit( 'a', 1 ), otherEdit( 'b', 2 ) ] );

			expect( shownText( replica ) ).toBe( 'b a Hello' );
			expect( replica.takeRestartRequest() ).toBe( false );
		} );

		it( 'asks to start over when a row is missing, and applies nothing more', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			replica.receive( [
				otherEdit( 'a', 1 ),
				otherEdit( 'c', 3 ),
				otherEdit( 'd', 4 ),
			] );

			expect( shownText( replica ) ).toBe( 'a Hello' );
			expect( replica.takeRestartRequest() ).toBe( true );
			expect( replica.takeRestartRequest() ).toBe( false );
		} );

		it( 'takes the person’s own stored edit as its answer', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const edit = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [
				{
					data: JSON.stringify( { ...edit, seq: 1 } ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				},
			] );

			expect( replica.getState() ).toBe( 'in-step' );
			expect( replica.getOutgoing() ).toEqual( [] );
			expect( shownText( replica ) ).toBe( 'Hello!' );
		} );
	} );

	describe( 'an answer', () => {
		it( 'takes the edit off the list, and an edit thrown away off the screen', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const edit = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receiveAnswers( [
				{
					intentId: edit.intentId,
					status: 'voided',
					reason: 'invalid-payload',
				},
			] );

			expect( replica.getState() ).toBe( 'in-step' );
			expect( shownText( replica ) ).toBe( 'Hello' );
			expect( seen.settled ).toHaveLength( 1 );
		} );

		it( 'for an edit that is not in the list changes nothing', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, '!' );
			replica.receiveAnswers( [
				{ intentId: 'someone-else', status: 'applied' },
			] );

			expect( replica.getState() ).toBe( 'waiting' );
			expect( shownText( replica ) ).toBe( 'Hello!' );
		} );
	} );

	describe( 'a lost connection', () => {
		it( 'makes everything on its way go out again, before newer work', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const first = type( replica, 'a' );

			replica.takeToSend( NO_LIMIT );

			const second = type( replica, 'b' );
			const announcedBefore = seen.workWaiting;

			replica.connectionLost();

			expect( marks( replica ) ).toEqual( [ 'send-again', 'not-sent' ] );
			expect( seen.workWaiting ).toBe( announcedBefore + 1 );
			expect(
				replica
					.takeToSend( NO_LIMIT )
					.map( ( update ) => JSON.parse( update.data ).intentId )
			).toEqual( [ first.intentId, second.intentId ] );
		} );
	} );

	describe( 'a reset', () => {
		it( 'is taken at once when nothing is unanswered', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			replica.receive( [ copy( 'Newer', 40 ) ] );

			expect( seen.resets ).toBe( 1 );
			expect( seen.recoveries ).toEqual( [] );
			expect( shownText( replica ) ).toBe( 'Newer' );
			expect( replica.getClient()?.cursor ).toBe( 40 );
		} );

		it( 'is taken at once when no edit was ever sent, and the edits are handed over to be made again', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, '!' );
			replica.receive( [ copy( 'Newer', 40 ), otherEdit( 'a', 41 ) ] );

			expect( replica.getState() ).toBe( 'in-step' );
			expect( replica.getOutgoing() ).toEqual( [] );
			expect( shownText( replica ) ).toBe( 'a Newer' );
			expect( seen.recoveries ).toHaveLength( 1 );

			// The difference to make again: "!" at the end of "Hello",
			// to be sent at the position after the rows of that answer.
			const [ { base, target, seq } ] = seen.recoveries;

			expect( contentText( base, 'p1' ) ).toBe( 'Hello' );
			expect( contentText( target, 'p1' ) ).toBe( 'Hello!' );
			expect( seq ).toBe( 41 );
		} );

		it( 'waits while an edit that was sent has no answer, and keeps later rows behind it', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ), otherEdit( 'a', 41 ) ] );

			expect( replica.getState() ).toBe( 'reset-waiting' );
			expect( seen.resets ).toBe( 0 );
			expect( shownText( replica ) ).toBe( 'Hello!' );

			// A key typed now shows, is not announced and is not sent.
			const announcedBefore = seen.workWaiting;

			type( replica, '?' );
			expect( shownText( replica ) ).toBe( 'Hello!?' );
			expect( seen.workWaiting ).toBe( announcedBefore );
			expect( replica.hasWorkToSend() ).toBe( false );
			expect( replica.takeToSend( NO_LIMIT ) ).toEqual( [] );

			// The server refuses the edit that was sent. It stays on
			// screen until the reset is taken, which is now.
			replica.receiveAnswers( [
				{
					intentId: sent.intentId,
					status: 'voided',
					reason: 'stale-base',
				},
			] );

			expect( seen.resets ).toBe( 1 );
			expect( replica.getState() ).toBe( 'in-step' );
			expect( shownText( replica ) ).toBe( 'a Newer' );
			expect( seen.recoveries ).toHaveLength( 1 );
			expect( contentText( seen.recoveries[ 0 ].base, 'p1' ) ).toBe(
				'Hello'
			);
			expect( contentText( seen.recoveries[ 0 ].target, 'p1' ) ).toBe(
				'Hello!?'
			);
		} );

		it( 'does not make an edit again that the server says it stored', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Hello!', 40 ) ] );
			replica.receiveAnswers( [
				{ intentId: sent.intentId, status: 'applied' },
			] );

			expect( replica.getState() ).toBe( 'in-step' );
			expect( seen.recoveries ).toEqual( [] );
			expect( shownText( replica ) ).toBe( 'Hello!' );
		} );

		it( 'sends an edit again after a lost connection while it waits, to get its answer', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ) ] );
			type( replica, '?' );
			replica.connectionLost();

			expect( replica.getState() ).toBe( 'reset-waiting' );
			expect(
				replica
					.takeToSend( NO_LIMIT )
					.map( ( update ) => JSON.parse( update.data ).intentId )
			).toEqual( [ sent.intentId ] );
		} );

		it( 'is replaced by a newer one that arrives while it waits', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ), otherEdit( 'a', 41 ) ] );
			replica.receive( [ copy( 'Newest', 90 ), otherEdit( 'b', 91 ) ] );
			replica.receiveAnswers( [
				{
					intentId: sent.intentId,
					status: 'voided',
					reason: 'stale-base',
				},
			] );

			expect( shownText( replica ) ).toBe( 'b Newest' );
			expect( replica.getClient()?.cursor ).toBe( 91 );
		} );

		it( 'stops waiting when the time limit passes, and counts an edit the server had stored after all', () => {
			const { replica, seen } = setUp();
			const warn = jest
				.spyOn( console, 'warn' )
				.mockImplementation( () => {} );

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ) ] );

			jest.advanceTimersByTime( RESET_WAIT_LIMIT_MS - 1 );
			expect( replica.getState() ).toBe( 'reset-waiting' );

			jest.advanceTimersByTime( 1 );
			expect( replica.getState() ).toBe( 'in-step' );
			expect( shownText( replica ) ).toBe( 'Newer' );
			expect( seen.recoveries ).toHaveLength( 1 );
			expect( replica.getDoubledAfterResetCount() ).toBe( 0 );

			replica.receiveAnswers( [
				{ intentId: sent.intentId, status: 'applied' },
			] );
			expect( replica.getDoubledAfterResetCount() ).toBe( 1 );
			expect( warn ).toHaveBeenCalledTimes( 1 );
			warn.mockRestore();
		} );

		it( 'lets what was held back go out once it is taken', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const sent = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ) ] );
			replica.resolveProposal( 'item-1', 'dismissed' );

			const announcedBefore = seen.workWaiting;

			expect( replica.hasWorkToSend() ).toBe( false );
			replica.receiveAnswers( [
				{
					intentId: sent.intentId,
					status: 'voided',
					reason: 'stale-base',
				},
			] );

			expect( seen.workWaiting ).toBe( announcedBefore + 1 );
			expect(
				replica.takeToSend( NO_LIMIT ).map( ( update ) => update.type )
			).toEqual( [ INTENT_LOG_UPDATE_TYPES.RESOLVED ] );
		} );
	} );

	describe( 'a room that starts over', () => {
		it( 'drops the document, the list and a reset that waits', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			type( replica, '!' );
			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ) ] );
			replica.restart();

			expect( replica.getState() ).toBe( 'no-document' );
			expect( replica.getOutgoing() ).toEqual( [] );
			expect( seen.resets ).toBe( 1 );

			jest.advanceTimersByTime( RESET_WAIT_LIMIT_MS );
			expect( replica.getState() ).toBe( 'no-document' );

			replica.receive( [ copy( 'Fresh' ) ] );
			expect( shownText( replica ) ).toBe( 'Fresh' );
		} );
	} );

	describe( 'undo of edits that have no answer', () => {
		it( 'takes edits that were never sent off the list and sends nothing', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const edit = type( replica, '!' );

			expect( replica.cancel( [ edit.intentId ] ) ).toBe( true );
			expect( replica.getOutgoing() ).toEqual( [] );
			expect( shownText( replica ) ).toBe( 'Hello' );
			// Nobody else will answer for it.
			expect( seen.settled ).toEqual( [
				{
					intentId: edit.intentId,
					status: 'voided',
					reason: 'canceled',
					predicted: null,
				},
			] );
		} );

		it( 'sends a cancellation after edits that are on their way', () => {
			const { replica, seen } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const edit = type( replica, '!' );

			replica.takeToSend( NO_LIMIT );

			expect( replica.cancel( [ edit.intentId ] ) ).toBe( true );
			expect( shownText( replica ) ).toBe( 'Hello' );
			expect( seen.settled ).toEqual( [] );
			expect(
				replica.takeToSend( NO_LIMIT ).map( ( update ) => update.type )
			).toEqual( [ INTENT_LOG_UPDATE_TYPES.CANCEL ] );

			// The server's answer takes the cancellation off the list.
			replica.receiveAnswers( [
				{ intentId: `cancel-${ edit.intentId }`, status: 'applied' },
			] );
			expect( replica.getOutgoing() ).toEqual( [] );
		} );

		it( 'is refused for an edit the server answered, and while a reset waits', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );

			const answered = type( replica, 'a' );

			replica.takeToSend( NO_LIMIT );
			replica.receiveAnswers( [
				{ intentId: answered.intentId, status: 'applied' },
			] );
			expect( replica.cancel( [ answered.intentId ] ) ).toBe( false );

			const sent = type( replica, 'b' );

			replica.takeToSend( NO_LIMIT );
			replica.receive( [ copy( 'Newer', 40 ) ] );
			expect( replica.cancel( [ sent.intentId ] ) ).toBe( false );
		} );
	} );

	describe( 'the list of review items', () => {
		/**
		 * A row for an edit of another person that the server set aside.
		 *
		 * @param id The edit's id.
		 * @return The row.
		 */
		const setAside = ( id: string ): EngineUpdate => ( {
			data: JSON.stringify( {
				intent: createIntent(
					'insert_text',
					{ syncId: 'p1', field: 'content', offset: 0, text: 'x' },
					{ actorId: 'u2c22', baseSeq: 0, intentId: id }
				),
				actorId: 'u2c22',
				reason: 'frame-conflict',
			} ),
			type: INTENT_LOG_UPDATE_TYPES.PARKED,
		} );
		const decided = ( id: string ): EngineUpdate => ( {
			data: JSON.stringify( { proposalId: id, resolution: 'dismissed' } ),
			type: INTENT_LOG_UPDATE_TYPES.RESOLVED,
		} );

		it( 'drops an item when its decision arrives, and a repeated row does not bring it back', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ), setAside( 'item-1' ) ] );
			expect( replica.getOpenProposals() ).toHaveLength( 1 );

			replica.receive( [ decided( 'item-1' ) ] );
			expect( replica.getProposals() ).toEqual( [] );

			replica.receive( [ setAside( 'item-1' ) ] );
			expect( replica.getProposals() ).toEqual( [] );
		} );

		it( 'keeps an item this tab decided until the server confirms, and opens it again when the server refuses', () => {
			const { replica } = setUp();

			replica.receive( [
				copy( 'Hello' ),
				setAside( 'item-1' ),
				setAside( 'item-2' ),
			] );
			replica.resolveProposal( 'item-1', 'dismissed' );
			replica.resolveProposal( 'item-2', 'dismissed' );
			expect( replica.getOpenProposals() ).toEqual( [] );
			expect( replica.getProposals() ).toHaveLength( 2 );

			replica.receiveAnswers( [
				{ intentId: 'item-1', status: 'resolved' },
				{
					intentId: 'item-2',
					status: 'refused',
					reason: 'not-allowed',
				},
			] );
			expect(
				replica
					.getOpenProposals()
					.map( ( proposal ) => proposal.intent.intentId )
			).toEqual( [ 'item-2' ] );
			expect( replica.getProposals() ).toHaveLength( 1 );
		} );

		it( 'is emptied when the room starts over, because the new room sends its own', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ), setAside( 'item-1' ) ] );
			replica.restart();
			expect( replica.getProposals() ).toEqual( [] );

			// The same room read again from its first row lists it again.
			replica.receive( [ copy( 'Hello' ), setAside( 'item-1' ) ] );
			expect( replica.getOpenProposals() ).toHaveLength( 1 );
		} );
	} );

	describe( 'a row with no number', () => {
		it( 'is taken as the next one, and skipped when the history holds it already', () => {
			const { replica } = setUp();
			const row: EngineUpdate = {
				data: JSON.stringify(
					createIntent(
						'insert_text',
						{
							syncId: 'p1',
							field: 'content',
							offset: 0,
							text: 'a ',
						},
						{ actorId: 'u2c22', baseSeq: 0, intentId: 'a' }
					)
				),
				type: INTENT_LOG_UPDATE_TYPES.INTENT,
			};

			replica.receive( [ copy( 'Hello' ) ] );
			// Something keeps the history: the editor still shows the
			// first document.
			replica.setShownSeq( 0 );
			replica.receive( [ row, row ] );
			replica.receive( [ row ] );

			expect( shownText( replica ) ).toBe( 'a Hello' );
			expect( replica.getClient()?.cursor ).toBe( 1 );
		} );
	} );

	describe( 'a review decision', () => {
		it( 'joins the list and leaves it with the server’s answer', () => {
			const { replica } = setUp();

			replica.receive( [ copy( 'Hello' ) ] );
			replica.resolveProposal( 'item-1', 'dismissed' );

			expect( replica.getState() ).toBe( 'in-step' );
			expect( replica.takeToSend( NO_LIMIT ) ).toHaveLength( 1 );

			replica.connectionLost();
			expect( replica.takeToSend( NO_LIMIT ) ).toHaveLength( 1 );

			replica.receiveAnswers( [
				{ intentId: 'item-1', status: 'resolved' },
			] );
			expect( replica.getOutgoing() ).toEqual( [] );
		} );
	} );
} );
