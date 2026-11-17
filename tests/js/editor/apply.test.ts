/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createDocument } from '../../../src/engines/intent-log/document.js';
import { applyIntent } from '../../../src/engines/intent-log/reducer.js';
import type { EngineDocument } from '../../../src/engines/intent-log/engine-types';
import {
	createEditorBlockBuilder,
	moveSelection,
} from '../../../src/editor/apply';
import { createBlockIdentityTable } from '../../../src/editor/identity';

/**
 * Applies one edit to a document.
 *
 * @param doc     The document.
 * @param type    The edit type.
 * @param payload The edit payload.
 * @return The next document.
 */
function edit(
	doc: EngineDocument,
	type: string,
	payload: Record< string, unknown >
): EngineDocument {
	return applyIntent( doc, {
		intentId: 'test',
		actorId: 'test',
		baseSeq: 0,
		txnId: null,
		type,
		payload,
	} ).doc;
}

const startingDocument = () =>
	createDocument( [
		{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
		{
			syncId: 'g1',
			blockType: 'core/group',
			children: [
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
			],
		},
	] );

/**
 * A builder with predictable clientIds: c1, c2, and so on.
 *
 * @return The builder and its id table.
 */
function setup() {
	const ids = createBlockIdentityTable();
	let next = 0;
	const builder = createEditorBlockBuilder( {
		ids,
		richTextFields: ( name ) =>
			'core/paragraph' === name ? [ 'content' ] : [],
		mintClientId: () => `c${ ++next }`,
	} );

	return { ids, builder };
}

describe( 'building editor blocks from the document', () => {
	it( 'builds valid blocks that carry their lasting id', () => {
		const { builder } = setup();

		expect( builder.build( startingDocument() ) ).toEqual( [
			{
				clientId: 'c1',
				name: 'core/paragraph',
				isValid: true,
				attributes: { content: 'One', metadata: { syncId: 'p1' } },
				innerBlocks: [],
			},
			{
				clientId: 'c3',
				name: 'core/group',
				isValid: true,
				attributes: { metadata: { syncId: 'g1' } },
				innerBlocks: [
					{
						clientId: 'c2',
						name: 'core/paragraph',
						isValid: true,
						attributes: {
							content: 'Two',
							metadata: { syncId: 'p2' },
						},
						innerBlocks: [],
					},
				],
			},
		] );
	} );

	it( 'uses the clientId the editor already knows a block by', () => {
		const { ids, builder } = setup();

		ids.link( 'from-the-editor', 'p1' );

		const [ first ] = builder.build( startingDocument() );

		expect( first.clientId ).toBe( 'from-the-editor' );
	} );

	it( 'links a block the editor does not hold yet to its new clientId', () => {
		const { ids, builder } = setup();
		const [ first ] = builder.build( startingDocument() );

		expect( ids.getSyncId( first.clientId ) ).toBe( 'p1' );
	} );

	it( 'keeps the clientIds over many builds', () => {
		const { builder } = setup();
		const doc = startingDocument();
		const first = builder.build( doc );
		const second = builder.build(
			edit( doc, 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: 3,
				text: '!',
			} )
		);

		expect( second.map( ( block ) => block.clientId ) ).toEqual(
			first.map( ( block ) => block.clientId )
		);
	} );

	it( 'hands over the same object for a block that did not change', () => {
		const { builder } = setup();
		const doc = startingDocument();
		const [ paragraphBefore, groupBefore ] = builder.build( doc );
		const [ paragraphAfter, groupAfter ] = builder.build(
			edit( doc, 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: 3,
				text: '!',
			} )
		);

		expect( paragraphAfter ).not.toBe( paragraphBefore );
		expect( paragraphAfter.attributes.content ).toBe( 'One!' );
		expect( groupAfter ).toBe( groupBefore );
	} );

	it( 'shares the attributes of a block when only something inside it changed', () => {
		const { builder } = setup();
		const doc = startingDocument();
		const [ , groupBefore ] = builder.build( doc );
		const [ , groupAfter ] = builder.build(
			edit( doc, 'insert_text', {
				syncId: 'p2',
				field: 'content',
				offset: 3,
				text: '!',
			} )
		);

		expect( groupAfter ).not.toBe( groupBefore );
		expect( groupAfter.attributes ).toBe( groupBefore.attributes );
		expect( groupAfter.innerBlocks[ 0 ].attributes.content ).toBe( 'Two!' );
	} );

	it( 'leaves out the attributes the engine keeps for itself', () => {
		const { builder } = setup();
		const [ first ] = builder.build(
			edit( startingDocument(), 'set_attr', {
				syncId: 'p1',
				key: '_wrapper',
				value: { open: '<p>', close: '</p>' },
				observedVersion: 0,
			} )
		);

		expect( first.attributes ).toEqual( {
			content: 'One',
			metadata: { syncId: 'p1' },
		} );
	} );

	it( 'fills in the default values a block type needs', () => {
		const ids = createBlockIdentityTable();
		const builder = createEditorBlockBuilder( {
			ids,
			richTextFields: () => [ 'content' ],
			withAttributeDefaults: ( name, attributes ) => ( {
				dropCap: false,
				...attributes,
			} ),
		} );
		const [ first ] = builder.build( startingDocument() );

		expect( first.attributes.dropCap ).toBe( false );
	} );

	it( 'writes the markup of a raw markup block where the block keeps it', () => {
		const ids = createBlockIdentityTable();
		const builder = createEditorBlockBuilder( {
			ids,
			richTextFields: () => [],
			rawContent: {
				is: ( name ) => 'core/html' === name,
				serialize: () => '',
				hydrate: ( _name, html ) => ( { innerContent: [ html ] } ),
			},
		} );
		const [ html ] = builder.build(
			createDocument( [
				{ syncId: 'h1', blockType: 'core/html', text: 'plain words' },
			] )
		);

		expect( html.innerContent ).toEqual( [ 'plain words' ] );
	} );

	it( 'builds everything anew after a reset', () => {
		const { builder } = setup();
		const doc = startingDocument();
		const [ before ] = builder.build( doc );

		builder.reset();

		const [ after ] = builder.build( doc );

		expect( after ).not.toBe( before );
		expect( after ).toEqual( before );
	} );
} );

describe( 'moving the selection along with the text', () => {
	const ids = createBlockIdentityTable();

	ids.link( 'c-1', 'p1' );

	const before = createDocument( [
		{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello world' },
	] );
	const caret = ( offset: number ) => {
		const end = { clientId: 'c-1', attributeKey: 'content', offset };

		return { selectionStart: end, selectionEnd: end };
	};
	const offsetAfter = ( offset: number, after: EngineDocument ) =>
		moveSelection( caret( offset ), before, after, ids )?.selectionStart
			?.offset;

	it( 'pushes the caret forward when text is added before it', () => {
		const after = edit( before, 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 0,
			text: 'Oh, ',
		} );

		expect( offsetAfter( 5, after ) ).toBe( 9 );
	} );

	it( 'leaves the caret alone when text is added after it', () => {
		const after = edit( before, 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 11,
			text: '!',
		} );

		expect( offsetAfter( 5, after ) ).toBe( 5 );
	} );

	it( 'keeps the caret in front of text added right at it', () => {
		const after = edit( before, 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 5,
			text: ',',
		} );

		expect( offsetAfter( 5, after ) ).toBe( 5 );
	} );

	it( 'pulls the caret back when text before it is removed', () => {
		const after = edit( before, 'delete_text', {
			syncId: 'p1',
			field: 'content',
			start: 0,
			end: 6,
			removedText: 'Hello ',
		} );

		expect( offsetAfter( 8, after ) ).toBe( 2 );
	} );

	it( 'puts a caret that was inside removed text where that text was', () => {
		const after = edit( before, 'delete_text', {
			syncId: 'p1',
			field: 'content',
			start: 4,
			end: 8,
			removedText: 'o wo',
		} );

		expect( offsetAfter( 6, after ) ).toBe( 4 );
	} );

	it( 'moves both ends of a selected range', () => {
		const after = edit( before, 'insert_text', {
			syncId: 'p1',
			field: 'content',
			offset: 0,
			text: 'Oh, ',
		} );
		const moved = moveSelection(
			{
				selectionStart: {
					clientId: 'c-1',
					attributeKey: 'content',
					offset: 0,
				},
				selectionEnd: {
					clientId: 'c-1',
					attributeKey: 'content',
					offset: 5,
				},
			},
			before,
			after,
			ids
		);

		expect( moved?.selectionStart?.offset ).toBe( 0 );
		expect( moved?.selectionEnd?.offset ).toBe( 9 );
	} );

	it( 'returns the same selection when nothing near it changed', () => {
		const selection = caret( 5 );

		expect( moveSelection( selection, before, before, ids ) ).toBe(
			selection
		);
	} );

	it( 'leaves a selection it cannot place as it is', () => {
		const blockOnly = {
			selectionStart: { clientId: 'c-1' },
			selectionEnd: { clientId: 'c-1' },
		};
		const unknownBlock = {
			selectionStart: {
				clientId: 'c-unknown',
				attributeKey: 'content',
				offset: 3,
			},
			selectionEnd: {},
		};

		expect( moveSelection( blockOnly, before, before, ids ) ).toBe(
			blockOnly
		);
		expect( moveSelection( unknownBlock, before, before, ids ) ).toBe(
			unknownBlock
		);
		expect(
			moveSelection( undefined, before, before, ids )
		).toBeUndefined();
	} );
} );
