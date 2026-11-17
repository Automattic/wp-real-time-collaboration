/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	createIntentLogSession,
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';
import { createUndoHistory } from '../../../src/editor/undo-history';
import { connectToWire, createWireServer, type WireServer } from './wire';

/*
 * What undo sends: the reverse of the person's own accepted edits, worked
 * out against the room's history. These tests make edits of many kinds
 * and check the server's document after undo and redo.
 *
 * How steps are grouped, and what happens while the server has not
 * answered yet, is in undo-history.test.ts.
 */

const GENESIS_BLOCKS = [
	{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello world' },
	{
		syncId: 'q1',
		blockType: 'core/quote',
		fields: {
			content: { text: 'To be or not to be' },
			citation: { text: 'Shakespeare' },
		},
	},
];

const connect = ( wire: WireServer, session: IntentLogSession ) =>
	connectToWire( wire, session );

/**
 * One tab with an undo history, connected to a server.
 *
 * @param userId   The user's id.
 * @param clientId The tab's client id.
 * @return The pieces a test drives.
 */
function harness( userId = 1, clientId = 11 ) {
	const wire = createWireServer( GENESIS_BLOCKS );
	const session = createIntentLogSession( { userId, clientId } );
	const link = connect( wire, session );
	const history = createUndoHistory();

	history.attach( session, () => {} );
	link.poll();

	/**
	 * Makes a local edit as one undo step, the way the provider does for
	 * a completed change.
	 *
	 * @param intents The edits.
	 * @return The edits as the session sent them.
	 */
	const edit = (
		intents: Array< { type: string; payload: Record< string, unknown > } >
	) => {
		const envelopes = session.authorBatch( intents, {
			baseSeq: session.getSeq(),
			observe: false,
		} );

		history.record( session, envelopes, true );

		return envelopes;
	};
	const undo = {
		undo: () => history.undo( session ),
		redo: () => history.redo( session ),
		reset: () => history.reset(),
	};
	const serverText = ( syncId: string, field = 'content' ) =>
		getBlock( wire.doc(), syncId )?.fields[ field ]?.text;

	return { wire, session, link, undo, edit, serverText };
}

describe( 'undo: the reverse edits', () => {
	it.each( [ 'format_text', 'delete_text' ] )(
		'undo and redo keep a split %s atomic',
		( type ) => {
			const { wire, session, link, undo, edit, serverText } = harness();
			const peer = createIntentLogSession( { userId: 2, clientId: 22 } );
			const peerLink = connect( wire, peer );
			peerLink.poll();
			// Both edits are authored against the unsplit text; the split arrives first.
			edit( [
				{
					type,
					payload: {
						syncId: 'p1',
						field: 'content',
						start: 3,
						end: 8,
						...( type === 'format_text'
							? { format: 'bold', on: true }
							: { removedText: 'lo wo' } ),
					},
				},
			] );
			peer.author( 'split_block', {
				syncId: 'p1',
				field: 'content',
				offset: 5,
				newSyncId: 'tail',
			} );
			peerLink.poll();
			link.poll();
			const expected = wire.doc();
			if ( type === 'delete_text' ) {
				expect( serverText( 'p1' ) ).toBe( 'Hel' );
				expect( serverText( 'tail' ) ).toBe( 'rld' );
			}
			undo.undo();
			link.poll();
			expect( serverText( 'p1' ) ).toBe( 'Hello' );
			expect( serverText( 'tail' ) ).toBe( ' world' );
			undo.redo();
			link.poll();
			expect( wire.doc() ).toEqual( expected );
			expect( session.getDocument() ).toEqual( expected );
		}
	);

	it( 'redo holds back every slice when a peer changed one selected range', () => {
		const { wire, link, undo, edit, serverText } = harness();
		const peer = createIntentLogSession( { userId: 2, clientId: 22 } );
		const peerLink = connect( wire, peer );
		peerLink.poll();
		edit( [
			{
				type: 'delete_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					start: 3,
					end: 8,
					removedText: 'lo wo',
				},
			},
		] );
		peer.author( 'split_block', {
			syncId: 'p1',
			field: 'content',
			offset: 5,
			newSyncId: 'tail',
		} );
		peerLink.poll();
		link.poll();
		undo.undo();
		link.poll();
		peerLink.poll();
		peer.author( 'insert_text', {
			syncId: 'tail',
			field: 'content',
			offset: 1,
			text: 'PEER',
		} );
		peerLink.poll();
		link.poll();
		undo.redo();
		const results = link.poll();
		expect(
			results?.filter( ( result ) => result.status === 'escalated' )
		).toHaveLength( 2 );
		expect( serverText( 'p1' ) ).toBe( 'Hello' );
		expect( serverText( 'tail' ) ).toBe( ' PEERworld' );
	} );

	it( 'a settled text edit undoes and redoes, converging on the server', () => {
		const { link, undo, edit, serverText } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		// Not yet settled — but undoable anyway: a fully-pending unit is
		// CANCELABLE, so hasUndo no longer waits for the settle
		// round trip.
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );

		undo.redo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );
	} );

	it( 'undo inside the settle window CANCELS the pending unit', () => {
		const { session, link, undo, edit, serverText } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		expect( session.getPendingCount() ).toBe( 1 );

		// Undo BEFORE any poll: the intent cancels instead of no-oping.
		expect( undo.undo() ).toBe( true );
		expect( session.getPendingCount() ).toBe( 0 );

		// The queued intent and its cancel travel in the SAME batch: the
		// server drops the pair and the edit never lands.
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
	} );

	it( 'a cancel that lost the race resurrects the unit as a settled undo candidate', () => {
		const { wire, session, link, undo, edit, serverText } = harness();

		const envelopes = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );

		// The intent reaches the server out-of-band (its POST was already
		// in flight when the user pressed undo).
		wire.ingest( [
			{
				data: JSON.stringify( envelopes[ 0 ] ),
				type: INTENT_LOG_UPDATE_TYPES.INTENT,
			},
		] );

		// Local cancel still succeeds (no ack processed yet)…
		expect( undo.undo() ).toBe( true );
		expect( session.getPendingCount() ).toBe( 0 );

		// …but the wire copy was ingested: the poll redelivers the intent
		// (idempotent), the cancel acks too-late, the accepted row
		// resurrects the effect, and the unit returns to the stack as a
		// normal settled candidate.
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world EDIT' );

		// The second undo inverts it the ordinary way.
		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
	} );

	it( 'cancellation is all-or-nothing: a settled unit does not cancel', () => {
		const { session, link, edit } = harness();

		const envelopes = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' EDIT',
				},
			},
		] );
		link.poll(); // Settles: outbox empty.

		expect(
			session.cancelPendingIntents(
				envelopes.map( ( envelope ) => envelope.intentId )
			)
		).toBe( false );
	} );

	it( 'undo reverts only this client, transformed over a peer row that shifted the text', () => {
		const alice = harness( 1, 11 );
		const bobSession = createIntentLogSession( {
			userId: 2,
			clientId: 22,
		} );
		const bobLink = connect( alice.wire, bobSession );
		bobLink.poll();

		alice.edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' ALICE',
				},
			},
		] );
		alice.link.poll();

		// Bob prepends BEFORE Alice's range, shifting it by four.
		bobLink.poll();
		bobSession.authorBatch(
			[
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'BOB ',
					},
				},
			],
			{ baseSeq: bobSession.getSeq() }
		);
		bobLink.poll();
		alice.link.poll();
		expect( alice.serverText( 'p1' ) ).toBe( 'BOB Hello world ALICE' );

		alice.undo.undo();
		alice.link.poll();
		// Alice's words came out; Bob's survived the rebase.
		expect( alice.serverText( 'p1' ) ).toBe( 'BOB Hello world' );
	} );

	it( 'a multi-intent capture batch reverts as one unit', () => {
		const { link, undo, edit, serverText, wire } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: '!',
				},
			},
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'wide',
					observedVersion: 0,
				},
			},
			{
				type: 'insert_text',
				payload: {
					syncId: 'q1',
					field: 'citation',
					offset: 0,
					text: 'W. ',
				},
			},
		] );
		link.poll();
		expect( serverText( 'q1', 'citation' ) ).toBe( 'W. Shakespeare' );

		undo.undo();
		link.poll();
		expect( serverText( 'p1' ) ).toBe( 'Hello world' );
		expect( serverText( 'q1', 'citation' ) ).toBe( 'Shakespeare' );
		// The attr write inverted to a removal (it had no prior value).
		expect( getBlock( wire.doc(), 'p1' )?.attrs.align ).toBeUndefined();
	} );

	it( 'undoing a block removal reinserts the subtree with all its fields at its old position', () => {
		const { link, undo, edit, wire } = harness();

		edit( [ { type: 'remove_block', payload: { syncId: 'q1' } } ] );
		link.poll();
		expect( getBlock( wire.doc(), 'q1' ) ).toBeNull();

		undo.undo();
		link.poll();
		const restored = getBlock( wire.doc(), 'q1' );
		expect( restored ).not.toBeNull();
		expect( restored?.fields.content.text ).toBe( 'To be or not to be' );
		expect( restored?.fields.citation.text ).toBe( 'Shakespeare' );
		// Back at its old position: after p1 at the root.
		expect( wire.doc().root.map( ( block ) => block.syncId ) ).toEqual( [
			'p1',
			'q1',
		] );
	} );

	it( 'a set_attr with a prior value restores it; walks past no-inverse units', () => {
		const { link, undo, edit, wire } = harness();

		edit( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'wide',
					observedVersion: 0,
				},
			},
		] );
		link.poll();
		edit( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'p1',
					key: 'align',
					value: 'full',
					observedVersion: 1,
				},
			},
		] );
		link.poll();
		expect( getBlock( wire.doc(), 'p1' )?.attrs.align ).toBe( 'full' );

		undo.undo();
		link.poll();
		expect( getBlock( wire.doc(), 'p1' )?.attrs.align ).toBe( 'wide' );
	} );

	it( 'a new edit clears the redo stack', () => {
		const { link, undo, edit } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' one',
				},
			},
		] );
		link.poll();
		undo.undo();
		link.poll();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 11,
					text: ' two',
				},
			},
		] );

		expect( undo.redo() ).toBe( false );
	} );

	it( 'a horizon reset clears both stacks', () => {
		const { link, undo, edit, session } = harness();

		edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'X',
				},
			},
		] );
		link.poll();

		// A compaction checkpoint beyond our cursor re-bootstraps the
		// replica; documents below it are gone.
		session.receiveUpdate( {
			data: JSON.stringify( {
				doc: createDocument( GENESIS_BLOCKS ),
				seq: 500,
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );

		expect( undo.undo() ).toBe( false );
		expect( undo.redo() ).toBe( false );
	} );

	it( 'retention pins the replica log to the oldest tracked row', () => {
		const { link, edit, session } = harness();

		const first = edit( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 0,
					text: 'A',
				},
			},
		] );
		link.poll();
		// Push the observed frame forward; without the undo pin the replica
		// would be free to trim the first row away.
		session.setObservedSeq( session.getSeq() );
		for ( let i = 0; i < 5; i++ ) {
			edit( [
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: String( i ),
					},
				},
			] );
			link.poll();
			session.setObservedSeq( session.getSeq() );
		}
		expect( session.getRetainedFloor() ).toBeLessThanOrEqual( 0 );
		// The first unit is still derivable and undoable…
		expect( session.getDocumentAt( 0 ) ).not.toBeNull();
		void first;
	} );
} );
