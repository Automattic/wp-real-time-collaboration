/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';
import { createIntent } from '../../../src/engines/intent-log/intents.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type {
	EngineDocument,
	IntentEnvelope,
} from '../../../src/engines/intent-log/engine-types';
import {
	captureBlockOperations,
	type CaptureContext,
	type CapturedIntent,
} from '../../../src/editor/capture';
import type {
	BlockOperation,
	EditorBlock,
} from '../../../src/editor/gutenberg-contract';
import {
	createBlockIdentityTable,
	type BlockIdentityTable,
} from '../../../src/editor/identity';
import { seedRecord, summarize } from './recordings';

/*
 * Capture, on batches written by hand. The batches a real editor sends
 * are replayed in capture-recordings.test.ts.
 *
 * In these tests an editor block's clientId is a short name such as
 * "c-w", and the document block it stands for gets the lasting id b1, b2,
 * and so on, in the order the blocks are listed.
 */

const GRIN = '\u{1F600}';
const BEAM = '\u{1F601}';

/**
 * An editor block.
 *
 * @param clientId    The editor's id for the block.
 * @param name        The block type.
 * @param attributes  The attributes.
 * @param innerBlocks The children.
 * @return The block.
 */
function block(
	clientId: string,
	name: string,
	attributes: Record< string, unknown > = {},
	innerBlocks: EditorBlock[] = []
): EditorBlock {
	return { clientId, name, attributes, innerBlocks };
}

/**
 * An editor paragraph.
 *
 * @param clientId   The editor's id for the block.
 * @param content    The text.
 * @param attributes More attributes.
 * @return The block.
 */
function paragraph(
	clientId: string,
	content: string,
	attributes: Record< string, unknown > = {}
): EditorBlock {
	return block( clientId, 'core/paragraph', { content, ...attributes } );
}

/** A document and its id table, with a way to capture against them. */
interface Setup {
	doc: EngineDocument;
	ids: BlockIdentityTable;
	capture: (
		operations: BlockOperation[],
		context?: Partial< CaptureContext >
	) => ReturnType< typeof captureBlockOperations >;
}

/**
 * Starts from an editor tree.
 *
 * @param tree The editor's blocks.
 * @return The document, the id table, and a capture function.
 */
function setup( tree: EditorBlock[] ): Setup {
	let nextId = 0;
	const mint = () => `b${ ++nextId }`;
	const { doc, ids } = seedRecord( tree, mint );

	return {
		doc,
		ids,
		capture: ( operations, context = {} ) =>
			captureBlockOperations( doc, operations, {
				ids,
				richTextFields: () => [ 'content' ],
				mintId: mint,
				...context,
			} ),
	};
}

/**
 * Turns captured edits into the rows one person sends.
 *
 * @param intents The captured edits.
 * @param actorId The person.
 * @return The rows, all made against the start of the room's history.
 */
function rowsFrom(
	intents: CapturedIntent[],
	actorId: string
): IntentEnvelope[] {
	return intents.map( ( intent, index ) =>
		createIntent( intent.type, intent.payload, {
			actorId,
			baseSeq: 0,
			intentId: `${ actorId }#${ index }`,
		} )
	);
}

const order = ( doc: EngineDocument ): string[] =>
	doc.root.map( ( entry ) => entry.syncId );

const text = ( doc: EngineDocument, syncId: string ): string | undefined =>
	getBlock( doc, syncId )?.fields.content.text;

describe( 'capture: placing blocks', () => {
	it( 'captures a new block as one insert and no move', () => {
		const { capture } = setup( [
			paragraph( 'c-w', 'W' ),
			paragraph( 'c-x', 'X' ),
		] );

		const { intents } = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-new', 'New' ),
				parent: null,
				before: 'c-x',
			},
		] );

		expect( intents ).toHaveLength( 1 );
		expect( intents[ 0 ] ).toMatchObject( {
			type: 'insert_block',
			payload: { parentId: null, afterSiblingId: 'b1' },
		} );
	} );

	it( 'captures "new block at the end, then move the next block" as one insert', () => {
		// The shape Gutenberg's tree comparison gives for the same action.
		const { capture, doc } = setup( [
			paragraph( 'c-w', 'W' ),
			paragraph( 'c-x', 'X' ),
		] );

		const result = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-new', 'New' ),
				parent: null,
				before: null,
			},
			{ type: 'move', clientId: 'c-x', parent: null, before: null },
		] );

		expect( summarize( result.intents ) ).toBe( 'insert_block' );
		expect( order( doc ) ).toEqual( [ 'b1', 'b2' ] );
		expect( order( result.doc ) ).toEqual( [ 'b1', 'b3', 'b2' ] );
	} );

	it( 'keeps the next block after both new blocks when two people insert at the same spot', () => {
		// Alice and Bob each put a new block in front of X. A move of X
		// from either of them would pull X in front of the other's block.
		const alice = setup( [
			paragraph( 'a-w', 'W' ),
			paragraph( 'a-x', 'X' ),
		] );
		const bob = setup( [
			paragraph( 'b-w', 'W' ),
			paragraph( 'b-x', 'X' ),
		] );
		const server = createServer( alice.doc );

		const fromAlice = alice.capture(
			[
				{
					type: 'insert',
					block: paragraph( 'a-new', 'From Alice' ),
					parent: null,
					before: 'a-x',
				},
			],
			{ mintId: () => 'alice-block' }
		);
		const fromBob = bob.capture(
			[
				{
					type: 'insert',
					block: paragraph( 'b-new', 'From Bob' ),
					parent: null,
					before: 'b-x',
				},
			],
			{ mintId: () => 'bob-block' }
		);
		const verdicts = [
			...serverIngestBatch(
				server,
				rowsFrom( fromAlice.intents, 'alice' )
			),
			...serverIngestBatch( server, rowsFrom( fromBob.intents, 'bob' ) ),
		];

		expect( verdicts.map( ( verdict ) => verdict.status ) ).toEqual( [
			'applied',
			'applied',
		] );
		expect( server.proposals ).toHaveLength( 0 );

		const result = order( serverDocAt( server, server.log.length ) );

		expect( result[ 0 ] ).toBe( 'b1' );
		expect( result[ 3 ] ).toBe( 'b2' );
		expect( [ ...result ].sort() ).toEqual( [
			'alice-block',
			'b1',
			'b2',
			'bob-block',
		] );
	} );

	it( 'moves only the block that moved', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
			paragraph( 'c-3', 'Three' ),
		] );

		// The first block goes to the end. The other two stay.
		const result = capture( [
			{ type: 'move', clientId: 'c-1', parent: null, before: null },
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'move_block',
				payload: {
					syncId: 'b1',
					newParentId: null,
					afterSiblingId: 'b3',
				},
			},
		] );
	} );

	it( 'moves the block the batch names when two blocks swap', () => {
		// Either block could move to give the same order. The person
		// moved the first one.
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );

		const result = capture( [
			{ type: 'move', clientId: 'c-1', parent: null, before: null },
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'move_block',
				payload: {
					syncId: 'b1',
					newParentId: null,
					afterSiblingId: 'b2',
				},
			},
		] );
	} );

	it( 'captures nothing for a move that changes nothing', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );

		const result = capture( [
			{ type: 'move', clientId: 'c-2', parent: null, before: null },
		] );

		expect( result.intents ).toEqual( [] );
	} );

	it( 'inserts a block with its children as one insert', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'insert',
				block: block( 'c-group', 'core/group', {}, [
					paragraph( 'c-inner', 'Inner' ),
				] ),
				parent: null,
				before: null,
			},
		] );

		expect( summarize( result.intents ) ).toBe( 'insert_block' );
		expect( result.intents[ 0 ].payload.block ).toMatchObject( {
			syncId: 'b2',
			blockType: 'core/group',
			children: [ { syncId: 'b3', blockType: 'core/paragraph' } ],
		} );
	} );

	it( 'inserts a block and its separately reported children as one insert', () => {
		// The tree comparison reports each new block by itself, the
		// children under the parent's clientId.
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'insert',
				block: block( 'c-list', 'core/list' ),
				parent: null,
				before: null,
			},
			{
				type: 'insert',
				block: block( 'c-item', 'core/list-item', { content: 'Item' } ),
				parent: 'c-list',
				before: null,
			},
		] );

		expect( summarize( result.intents ) ).toBe( 'insert_block' );
		expect( result.intents[ 0 ].payload.block ).toMatchObject( {
			blockType: 'core/list',
			children: [ { blockType: 'core/list-item' } ],
		} );
	} );

	it( 'captures nothing for a block inserted and removed in one batch', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-new', 'New' ),
				parent: null,
				before: null,
			},
			{ type: 'remove', clientId: 'c-new' },
		] );

		expect( result.intents ).toEqual( [] );
	} );

	it( 'moves a child out before its parent is removed', () => {
		// Ungroup: the child goes to the top level and the group goes.
		const { capture } = setup( [
			block( 'c-group', 'core/group', {}, [
				paragraph( 'c-inner', 'Inner' ),
			] ),
		] );

		const result = capture( [
			{ type: 'move', clientId: 'c-inner', parent: null, before: null },
			{ type: 'remove', clientId: 'c-group' },
		] );

		// The child goes in front: no block that stays comes before it.
		expect( result.intents ).toEqual( [
			{
				type: 'move_block',
				payload: {
					syncId: 'b2',
					newParentId: null,
					afterSiblingId: null,
				},
			},
			{ type: 'remove_block', payload: { syncId: 'b1' } },
		] );
		expect( order( result.doc ) ).toEqual( [ 'b2' ] );
	} );

	it( 'forgets the ids of removed blocks', () => {
		const { capture, ids } = setup( [
			block( 'c-group', 'core/group', {}, [
				paragraph( 'c-inner', 'Inner' ),
			] ),
			paragraph( 'c-1', 'One' ),
		] );

		capture( [ { type: 'remove', clientId: 'c-group' } ] );

		expect( ids.getSyncId( 'c-group' ) ).toBeUndefined();
		expect( ids.getSyncId( 'c-inner' ) ).toBeUndefined();
		expect( ids.getSyncId( 'c-1' ) ).toBe( 'b3' );
	} );
} );

describe( 'capture: which block is which', () => {
	it( 'keeps the ids of blocks that are copied into a new group', () => {
		// Group two blocks: Gutenberg inserts copies under new clientIds
		// and removes the originals. The copies carry the saved ids.
		const { capture, ids } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );

		const result = capture( [
			{
				type: 'insert',
				block: block( 'c-group', 'core/group' ),
				parent: null,
				before: null,
			},
			{
				type: 'insert',
				block: paragraph( 'c-1-copy', 'One', {
					metadata: { syncId: 'b1' },
				} ),
				parent: 'c-group',
				before: null,
			},
			{
				type: 'insert',
				block: paragraph( 'c-2-copy', 'Two', {
					metadata: { syncId: 'b2' },
				} ),
				parent: 'c-group',
				before: null,
			},
			{ type: 'remove', clientId: 'c-1' },
			{ type: 'remove', clientId: 'c-2' },
		] );

		expect( summarize( result.intents ) ).toBe(
			'insert_block, move_block x2'
		);
		expect( order( result.doc ) ).toEqual( [ 'b3' ] );
		expect(
			getBlock( result.doc, 'b3' )?.children.map(
				( child ) => child.syncId
			)
		).toEqual( [ 'b1', 'b2' ] );
		expect( ids.getSyncId( 'c-1-copy' ) ).toBe( 'b1' );
		expect( ids.getSyncId( 'c-1' ) ).toBeUndefined();
	} );

	it( 'gives a duplicate its own id', () => {
		// Duplicate copies every attribute, the saved id included. The
		// original still exists, so the copy is a new block.
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-copy', 'One', {
					metadata: { syncId: 'b1' },
				} ),
				parent: null,
				before: null,
			},
		] );

		expect( result.intents[ 0 ].payload.block ).toMatchObject( {
			syncId: 'b2',
		} );
		expect( result.identityNeedsWrite ).toBe( true );
	} );

	it( 'keeps the saved id of a block the document does not hold', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-pasted', 'Pasted', {
					metadata: { syncId: 'from-elsewhere', name: 'Intro' },
				} ),
				parent: null,
				before: null,
			},
		] );

		// The id names the block. It is not kept as an attribute.
		expect( result.intents[ 0 ].payload.block ).toMatchObject( {
			syncId: 'from-elsewhere',
			attrs: { metadata: { name: 'Intro' } },
		} );
		expect( result.identityNeedsWrite ).toBe( false );
	} );

	it( 'does not treat a replaced block of the same type as the same block', () => {
		// One paragraph removed and another put in its place is not a
		// change of block type. Other people's edits to the old paragraph
		// must not land in the new one.
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );

		const result = capture( [
			{
				type: 'insert',
				block: paragraph( 'c-new', '' ),
				parent: null,
				before: 'c-2',
			},
			{ type: 'remove', clientId: 'c-1' },
		] );

		expect( summarize( result.intents ) ).toBe(
			'insert_block, remove_block'
		);
	} );

	it( 'does not treat a block of another type in another place as the same block', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
			paragraph( 'c-3', 'Three' ),
		] );

		const result = capture( [
			{
				type: 'insert',
				block: block( 'c-heading', 'core/heading', { content: 'One' } ),
				parent: null,
				before: null,
			},
			{ type: 'remove', clientId: 'c-1' },
		] );

		expect( summarize( result.intents ) ).toBe(
			'insert_block, remove_block'
		);
	} );

	it( 'counts an operation on a block it does not know and captures nothing', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-unknown',
				attribute: 'content',
				previousValue: 'One',
				value: 'One!',
			},
		] );

		expect( result.intents ).toEqual( [] );
		expect( result.counters.unknownClientId ).toBe( 1 );
	} );

	it( 'finds an unknown block again through its saved id', () => {
		// After the editor parses the content again, the block has a new
		// clientId but still carries its saved id.
		const { capture, ids } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-reparsed',
					attribute: 'content',
					previousValue: 'One',
					value: 'One!',
				},
			],
			{ lookupSavedSyncId: () => 'b1' }
		);

		expect( summarize( result.intents ) ).toBe( 'insert_text' );
		expect( result.counters.unknownClientId ).toBe( 0 );
		expect( ids.getSyncId( 'c-reparsed' ) ).toBe( 'b1' );
	} );
} );

describe( 'capture: text', () => {
	it( 'does not cut an emoji in half when one emoji replaces another', () => {
		const { capture } = setup( [ paragraph( 'c-1', `A${ GRIN }B` ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: `A${ GRIN }B`,
				value: `A${ BEAM }B`,
			},
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'replace_text',
				payload: {
					syncId: 'b1',
					field: 'content',
					start: 1,
					end: 3,
					removedText: GRIN,
					text: BEAM,
				},
			},
		] );
	} );

	it( 'leaves no half emoji when two people each delete a different emoji', () => {
		const start = `A${ GRIN }${ BEAM }B`;
		const alice = setup( [ paragraph( 'a-1', start ) ] );
		const bob = setup( [ paragraph( 'b-1', start ) ] );
		const server = createServer( alice.doc );

		const fromAlice = alice.capture( [
			{
				type: 'set-attribute',
				clientId: 'a-1',
				attribute: 'content',
				previousValue: start,
				value: `A${ BEAM }B`,
			},
		] );
		const fromBob = bob.capture( [
			{
				type: 'set-attribute',
				clientId: 'b-1',
				attribute: 'content',
				previousValue: start,
				value: `A${ GRIN }B`,
			},
		] );
		const verdicts = [
			...serverIngestBatch(
				server,
				rowsFrom( fromAlice.intents, 'alice' )
			),
			...serverIngestBatch( server, rowsFrom( fromBob.intents, 'bob' ) ),
		];

		expect( verdicts.map( ( verdict ) => verdict.status ) ).toEqual( [
			'applied',
			'applied',
		] );
		expect( text( serverDocAt( server, server.log.length ), 'b1' ) ).toBe(
			'AB'
		);
	} );

	it( 'uses the selection before the batch to replace a whole selection', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'Hello world' ) ] );
		const at = ( offset: number ) => ( {
			clientId: 'c-1',
			attributeKey: 'content',
			offset,
		} );

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'Hello world',
					value: 'Hello w',
				},
			],
			{
				previousSelection: {
					selectionStart: at( 6 ),
					selectionEnd: at( 11 ),
				},
				selection: { selectionStart: at( 7 ), selectionEnd: at( 7 ) },
			}
		);

		expect( result.intents[ 0 ].payload ).toMatchObject( {
			start: 6,
			end: 11,
			removedText: 'world',
			text: 'w',
		} );
	} );

	it( 'captures a change of formatting as format edits only', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'Hello world' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'Hello world',
				value: '<strong>Hello</strong> world',
			},
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'format_text',
				payload: {
					syncId: 'b1',
					field: 'content',
					start: 0,
					end: 5,
					format: 'strong',
					on: true,
				},
			},
		] );
	} );

	it( 'accepts a rich text object and a plain string for the same text', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'Hello' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: { toHTMLString: () => 'Hello' },
				value: { toHTMLString: () => 'Hello!' },
			},
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'b1',
					field: 'content',
					offset: 5,
					text: '!',
				},
			},
		] );
	} );

	it( 'applies several changes to one text in the order they were made', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'abc' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'abc',
				value: 'abcd',
			},
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'abcd',
				value: 'Xabcd',
			},
		] );

		expect( summarize( result.intents ) ).toBe( 'insert_text x2' );
		expect( text( result.doc, 'b1' ) ).toBe( 'Xabcd' );
		expect( result.counters.stalePreviousValue ).toBe( 0 );
	} );

	it( 'does not report a split when the two texts do not add up to the old text', () => {
		// Paste two paragraphs into the middle of "Hello world".
		const { capture } = setup( [ paragraph( 'c-1', 'Hello world' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'Hello world',
				value: 'HelloPasted A',
			},
			{
				type: 'insert',
				block: paragraph( 'c-2', 'Pasted B world' ),
				parent: null,
				before: null,
			},
		] );

		expect( summarize( result.intents ) ).toBe(
			'insert_block, replace_text'
		);
		expect( text( result.doc, 'b1' ) ).toBe( 'HelloPasted A' );
	} );

	it( 'does not report a merge when the removed block was not the next one', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'Hello ' ),
			paragraph( 'c-2', 'between' ),
			paragraph( 'c-3', 'world' ),
		] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'Hello ',
				value: 'Hello world',
			},
			{ type: 'remove', clientId: 'c-3' },
		] );

		expect( summarize( result.intents ) ).toBe(
			'remove_block, insert_text'
		);
	} );
} );

describe( 'capture: an editor that is behind the engine', () => {
	it( 'places the change the person made on the engine’s newer text, and counts it', () => {
		// Someone else added " X" and the editor has not shown it yet.
		// The person types "a" after the first letter of the text they
		// see, "abc".
		const { capture } = setup( [ paragraph( 'c-1', 'abc X' ) ] );
		const caret = { clientId: 'c-1', attributeKey: 'content', offset: 2 };

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'abc',
					value: 'aabc',
				},
			],
			{ selection: { selectionStart: caret, selectionEnd: caret } }
		);

		expect( result.intents ).toEqual( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'b1',
					field: 'content',
					offset: 1,
					text: 'a',
				},
			},
		] );
		// The other person's text is still there.
		expect( text( result.doc, 'b1' ) ).toBe( 'aabc X' );
		expect( result.counters.stalePreviousValue ).toBe( 1 );
	} );

	it( 'counts a plain attribute whose old value is not the engine’s', () => {
		const { capture } = setup( [
			block( 'c-1', 'core/heading', { content: 'Title', level: 3 } ),
		] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'level',
				previousValue: 2,
				value: 4,
			},
		] );

		expect( summarize( result.intents ) ).toBe( 'set_attr' );
		expect( result.counters.stalePreviousValue ).toBe( 1 );
	} );
} );

describe( 'capture: attributes', () => {
	it( 'sends only the attribute the batch names', () => {
		/*
		 * The server builds its first copy of a post from the block
		 * comments, which leave out default values such as a paragraph's
		 * `dropCap: false`. The editor's blocks always carry them. Typing
		 * must not send those defaults as edits: two people who both did
		 * would each get a review card on every paragraph.
		 */
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
		] );

		ids.link( 'c-1', 'p1' );

		const result = captureBlockOperations(
			doc,
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'One',
					value: 'One!',
				},
			],
			{ ids, richTextFields: () => [ 'content' ] }
		);

		expect( summarize( result.intents ) ).toBe( 'insert_text' );
	} );

	it( 'does not send a default value the document leaves out when a whole block arrives', () => {
		// The block is removed and inserted again in one batch, so it
		// arrives whole, defaults included.
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
			{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
		] );

		ids.link( 'c-1', 'p1' );
		ids.link( 'c-2', 'p2' );

		const result = captureBlockOperations(
			doc,
			[
				{ type: 'remove', clientId: 'c-1' },
				{
					type: 'insert',
					block: paragraph( 'c-1', 'One', { dropCap: false } ),
					parent: null,
					before: null,
				},
			],
			{
				ids,
				richTextFields: () => [ 'content' ],
				attributeDefaults: () => ( { dropCap: false } ),
			}
		);

		expect( result.intents ).toEqual( [
			{
				type: 'move_block',
				payload: {
					syncId: 'p1',
					newParentId: null,
					afterSiblingId: 'p2',
				},
			},
		] );
	} );

	it( 'sets, changes and clears a plain attribute', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One', { align: 'left' } ),
		] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'fontSize',
				previousValue: undefined,
				value: 'large',
			},
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'align',
				previousValue: 'left',
				value: undefined,
			},
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'b1',
					key: 'fontSize',
					value: 'large',
					observedVersion: 0,
				},
			},
			{
				type: 'remove_attr',
				payload: { syncId: 'b1', key: 'align', observedVersion: 0 },
			},
		] );
	} );

	it( 'captures nothing when a value does not change', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One', { align: 'left' } ),
		] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'align',
				previousValue: 'left',
				value: 'left',
			},
		] );

		expect( result.intents ).toEqual( [] );
	} );

	it( 'does not send the lasting id as an attribute', () => {
		// The engine writes the id into the block's metadata itself.
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'metadata',
				previousValue: undefined,
				value: { syncId: 'b1' },
			},
		] );

		expect( result.intents ).toEqual( [] );
	} );

	it( 'changes the block type when the editor changes it in place', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );

		const result = capture( [
			{
				type: 'set-block-property',
				clientId: 'c-1',
				property: 'name',
				previousValue: 'core/paragraph',
				value: 'core/heading',
			},
			{
				type: 'set-block-property',
				clientId: 'c-1',
				property: 'isValid',
				previousValue: true,
				value: false,
			},
		] );

		expect( result.intents ).toEqual( [
			{
				type: 'transform_block',
				payload: { syncId: 'b1', newBlockType: 'core/heading' },
			},
		] );
	} );

	it( 'captures the markup of a raw markup block as text', () => {
		const { capture } = setup( [ block( 'c-1', 'core/html', {} ) ] );

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: undefined,
					value: 'plain words',
				},
			],
			{
				richTextFields: () => [],
				rawContent: {
					is: ( name ) => 'core/html' === name,
					serialize: () => '',
				},
			}
		);

		expect( result.intents ).toEqual( [
			{
				type: 'insert_text',
				payload: {
					syncId: 'b1',
					field: 'content',
					offset: 0,
					text: 'plain words',
				},
			},
		] );
	} );
} );

describe( 'capture: saved markup', () => {
	it( 'renders the markup again for a block whose attribute changed, and only that block', () => {
		const { capture } = setup( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );
		const saveMarkup = jest.fn(
			() => '<p class="has-text-align-center">One</p>'
		);

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'align',
					previousValue: undefined,
					value: 'center',
				},
			],
			{ saveMarkup }
		);

		expect( saveMarkup ).toHaveBeenCalledTimes( 1 );
		expect( result.intents ).toEqual( [
			{
				type: 'set_attr',
				payload: {
					syncId: 'b1',
					key: 'align',
					value: 'center',
					observedVersion: 0,
				},
			},
			{
				type: 'set_attr',
				payload: {
					syncId: 'b1',
					key: '_wrapper',
					value: {
						open: '<p class="has-text-align-center">',
						close: '</p>',
					},
					observedVersion: 0,
				},
			},
		] );
	} );

	it( 'does not render markup for typing in a block with a content field', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );
		const saveMarkup = jest.fn( () => '<p>One!</p>' );

		capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'One',
					value: 'One!',
				},
			],
			{ saveMarkup }
		);

		expect( saveMarkup ).not.toHaveBeenCalled();
	} );

	it( 'keeps the whole markup of a block that has no content field', () => {
		// An image: its caption is a text field, and everything else the
		// server writes comes from the rendered markup.
		const { capture } = setup( [
			block( 'c-1', 'core/image', { url: 'a.png', caption: 'Old' } ),
		] );

		const result = capture(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'url',
					previousValue: 'a.png',
					value: 'b.png',
				},
			],
			{
				richTextFields: () => [ 'caption' ],
				saveMarkup: () => '<figure><img src="b.png"/></figure>',
			}
		);

		expect( summarize( result.intents ) ).toBe(
			'set_attr x2, insert_text, format_text'
		);
		expect( getBlock( result.doc, 'b1' )?.attrs._wrapper ).toEqual( {
			open: '<figure>',
			close: '</figure>',
		} );
	} );
} );

describe( 'capture: blocks inside a raw markup block', () => {
	const rawContent = {
		is: ( name: string ) => 'core/html' === name,
		// A stand-in for the editor's serializer: the markup pieces, with
		// each inner block written as its name.
		serialize: ( html: {
			innerContent?: Array< string | null >;
			innerBlocks: Array< { name: string } >;
		} ) => {
			let next = 0;

			return ( html.innerContent ?? [] )
				.map(
					( piece ) =>
						piece ?? `[${ html.innerBlocks[ next++ ]?.name }]`
				)
				.join( '' );
		},
	};
	const context = { richTextFields: () => [], rawContent };

	it( 'keeps the blocks inside a new raw markup block as part of its markup', () => {
		const { capture } = setup( [ paragraph( 'c-1', 'One' ) ] );
		const html: EditorBlock = {
			...block( 'c-html', 'core/html', {}, [
				paragraph( 'c-inner', 'In' ),
			] ),
			innerContent: [ 'before ', null, ' after' ],
		};

		const result = capture(
			[ { type: 'insert', block: html, parent: null, before: null } ],
			context
		);

		expect( summarize( result.intents ) ).toBe( 'insert_block' );
		expect( result.intents[ 0 ].payload.block ).toMatchObject( {
			blockType: 'core/html',
			children: [],
			fields: { content: { text: 'before [core/paragraph] after' } },
		} );
		expect( result.rawContentToRefresh ).toEqual( [] );
	} );

	it( 'asks for the markup again when a block is placed inside an existing raw markup block', () => {
		const { capture } = setup( [ block( 'c-html', 'core/html' ) ] );

		const result = capture(
			[
				{
					type: 'set-block-property',
					clientId: 'c-html',
					property: 'innerContent',
					previousValue: [ 'old' ],
					value: [ 'before ', null ],
				},
				{
					type: 'insert',
					block: paragraph( 'c-inner', 'In' ),
					parent: 'c-html',
					before: null,
				},
			],
			context
		);

		// The operations do not hold the whole markup. Nothing is sent
		// from them, and no block is added inside the raw markup block.
		expect( result.intents ).toEqual( [] );
		expect( result.rawContentToRefresh ).toEqual( [ 'b1' ] );
	} );

	it( 'captures markup with no blocks inside straight from the operation', () => {
		const { capture } = setup( [ block( 'c-html', 'core/html' ) ] );

		const result = capture(
			[
				{
					type: 'set-block-property',
					clientId: 'c-html',
					property: 'innerContent',
					previousValue: [],
					value: [ 'plain words' ],
				},
			],
			context
		);

		expect( summarize( result.intents ) ).toBe( 'insert_text' );
		expect( result.rawContentToRefresh ).toEqual( [] );
	} );
} );
