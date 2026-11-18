/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createIntentLogSession } from '../../../src/engines/intent-log-session';
import { getBlock } from '../../../src/engines/intent-log/document.js';
import { createUndoHistory } from '../../../src/editor/undo-history';
import { connectToWire, createWireServer, type WireServer } from './wire';

const BLOCKS = [
	{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello world' },
	{ syncId: 'p2', blockType: 'core/paragraph', text: 'Second' },
];

/**
 * One tab with an undo history, connected to a server.
 *
 * @param wire     The server. A new one when left out.
 * @param clientId The tab's client id.
 * @return The pieces a test drives.
 */
function tab( wire: WireServer = createWireServer( BLOCKS ), clientId = 11 ) {
	const session = createIntentLogSession( { userId: 1, clientId } );
	const link = connectToWire( wire, session );
	const history = createUndoHistory();
	const onLevelOpened = jest.fn();

	history.attach( session, onLevelOpened );
	link.poll();

	/**
	 * Makes a local edit, the way the provider does for one batch.
	 *
	 * @param text           The text to add at the end of the first block.
	 * @param startsNewLevel Whether the batch is a completed change.
	 */
	const type = ( text: string, startsNewLevel = true ) => {
		const current =
			getBlock( session.getDocument() ?? wire.doc(), 'p1' )?.fields
				.content.text ?? '';

		history.record(
			session,
			session.authorBatch(
				[
					{
						type: 'insert_text',
						payload: {
							syncId: 'p1',
							field: 'content',
							offset: current.length,
							text,
						},
					},
				],
				{ baseSeq: session.getSeq() }
			),
			startsNewLevel
		);
	};

	const serverText = () => getBlock( wire.doc(), 'p1' )?.fields.content.text;
	const localText = () => {
		const doc = session.getDocument();

		return doc ? getBlock( doc, 'p1' )?.fields.content.text : undefined;
	};

	return {
		wire,
		session,
		link,
		history,
		onLevelOpened,
		type,
		serverText,
		localText,
	};
}

describe( 'undo history', () => {
	it( 'undoes and redoes an edit the server has answered', () => {
		const { history, session, link, type, serverText } = tab();

		type( '!' );
		link.poll();
		expect( serverText() ).toBe( 'Hello world!' );

		expect( history.undo( session ) ).toBe( true );
		link.poll();
		expect( serverText() ).toBe( 'Hello world' );

		expect( history.redo( session ) ).toBe( true );
		link.poll();
		expect( serverText() ).toBe( 'Hello world!' );
	} );

	it( 'says there is nothing to undo for a record with no steps', () => {
		const { history, session } = tab();

		expect( history.undo( session ) ).toBe( false );
		expect( history.redo( session ) ).toBe( false );
	} );

	it( 'reports a new step to core-data once per step', () => {
		const { type, onLevelOpened } = tab();

		// The first key of a typing run is a completed change. The keys
		// after it are changes in progress.
		type( 'a', true );
		type( 'b', false );
		type( 'c', false );
		expect( onLevelOpened ).toHaveBeenCalledTimes( 1 );

		type( 'd', true );
		expect( onLevelOpened ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'undoes a whole typing run as one step', () => {
		const { history, session, link, type, serverText } = tab();

		type( 'a', true );
		type( 'b', false );
		type( 'c', false );
		link.poll();
		expect( serverText() ).toBe( 'Hello worldabc' );

		expect( history.undo( session ) ).toBe( true );
		link.poll();
		expect( serverText() ).toBe( 'Hello world' );
		expect( history.undo( session ) ).toBe( false );
	} );

	it( 'starts a new step after stopCapturing, even for a change in progress', () => {
		const { history, session, link, type, serverText, onLevelOpened } =
			tab();

		type( 'a', true );
		history.stopCapturing();
		type( 'b', false );
		link.poll();
		expect( onLevelOpened ).toHaveBeenCalledTimes( 2 );

		history.undo( session );
		link.poll();
		expect( serverText() ).toBe( 'Hello worlda' );
	} );

	it( 'takes back an edit the server has not seen yet', () => {
		const { history, session, link, type, serverText, localText } = tab();

		type( '!' );
		expect( localText() ).toBe( 'Hello world!' );

		expect( history.undo( session ) ).toBe( true );
		expect( localText() ).toBe( 'Hello world' );

		link.poll();
		expect( serverText() ).toBe( 'Hello world' );
	} );

	it( 'waits for the server when it has answered only part of a step', () => {
		const { history, session, link, type, serverText } = tab();

		type( 'a', true );
		link.poll();
		// The second key of the same step is still unanswered.
		type( 'b', false );

		expect( history.undo( session ) ).toBe( true );
		// Nothing can be reversed yet.
		expect( link.queued() ).toBe( 1 );

		// The answer arrives, and the reverse edits go out with it.
		link.poll();
		expect( link.queued() ).toBeGreaterThan( 0 );
		link.poll();
		expect( serverText() ).toBe( 'Hello world' );

		// The redo step was filled when the undo was carried out.
		expect( history.redo( session ) ).toBe( true );
		link.poll();
		expect( serverText() ).toBe( 'Hello worldab' );
	} );

	it( 'calls a waiting undo off when redo is asked for first', () => {
		const { history, session, link, type, serverText } = tab();

		type( 'a', true );
		link.poll();
		type( 'b', false );

		expect( history.undo( session ) ).toBe( true );
		expect( history.redo( session ) ).toBe( true );
		link.poll();
		link.poll();
		expect( serverText() ).toBe( 'Hello worldab' );

		// The step is a step again.
		expect( history.undo( session ) ).toBe( true );
		link.poll();
		expect( serverText() ).toBe( 'Hello world' );
	} );

	it( 'still carries out a waiting undo when the person types something new', () => {
		const { history, session, link, type, serverText } = tab();

		type( 'a', true );
		link.poll();
		type( 'b', false );

		expect( history.undo( session ) ).toBe( true );
		type( 'Z', true );
		link.poll();
		link.poll();

		expect( serverText() ).toBe( 'Hello worldZ' );
		// The new edit ended the redo history.
		expect( history.redo( session ) ).toBe( false );
	} );

	it( 'reverses only this person’s edit, around what someone else did since', () => {
		const wire = createWireServer( BLOCKS );
		const alice = tab( wire, 11 );
		const bob = tab( wire, 22 );

		alice.type( '!' );
		alice.link.poll();

		// Bob adds text in front, after seeing Alice's edit.
		bob.link.poll();
		bob.session.authorBatch(
			[
				{
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'Oh, ',
					},
				},
			],
			{ baseSeq: bob.session.getSeq() }
		);
		bob.link.poll();
		alice.link.poll();

		expect( alice.history.undo( alice.session ) ).toBe( true );
		alice.link.poll();
		expect( alice.serverText() ).toBe( 'Oh, Hello world' );
	} );

	it( 'says a step had no effect when the server refused all of its edits', () => {
		const wire = createWireServer( BLOCKS );
		const alice = tab( wire, 11 );
		const bob = tab( wire, 22 );

		// Bob removes the block while Alice types in it.
		bob.session.authorBatch(
			[ { type: 'remove_block', payload: { syncId: 'p1' } } ],
			{ baseSeq: bob.session.getSeq() }
		);
		alice.type( '!' );
		bob.link.poll();
		alice.link.poll();

		// core-data moves on to the step before it.
		expect( alice.history.undo( alice.session ) ).toBe( false );
	} );

	it( 'drops the redo steps of every record on clearRedo', () => {
		const { history, session, link, type } = tab();

		type( '!' );
		link.poll();
		history.undo( session );
		link.poll();

		history.clearRedo();

		expect( history.redo( session ) ).toBe( false );
	} );

	it( 'keeps one history per record', () => {
		const history = createUndoHistory();
		const first = tab();
		const second = tab();

		// Two records share one history object, as in the provider.
		history.attach( first.session, jest.fn() );
		history.attach( second.session, jest.fn() );

		history.record(
			first.session,
			first.session.authorBatch(
				[
					{
						type: 'insert_text',
						payload: {
							syncId: 'p1',
							field: 'content',
							offset: 0,
							text: 'X',
						},
					},
				],
				{ baseSeq: first.session.getSeq() }
			),
			true
		);
		first.link.poll();

		expect( history.undo( second.session ) ).toBe( false );
		expect( history.undo( first.session ) ).toBe( true );
	} );

	it( 'forgets a record’s steps when it is detached', () => {
		const { history, session, link, type } = tab();

		type( '!' );
		link.poll();
		history.detach( session );

		expect( history.undo( session ) ).toBe( false );
	} );

	it( 'keeps the session’s history long enough to reverse the oldest step', () => {
		const { history, session, link, type } = tab();
		const pin = jest.spyOn( session, 'setUndoRetainSeq' );

		type( 'a' );
		link.poll();
		type( 'b' );
		link.poll();

		// The first accepted edit sits at position 0.
		expect( pin ).toHaveBeenLastCalledWith( 0 );

		history.reset();
		expect( pin ).toHaveBeenLastCalledWith( null );
	} );
} );
