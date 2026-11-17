/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	listRecordings,
	loadRecording,
	replay,
	summarize,
	type ComparableBlock,
} from './recordings';

/*
 * Replays what a real editor sent (tests/fixtures/edit-batches/) through
 * capture. Two things are checked for every recording: the engine's
 * document equals the editor's blocks after each batch, and each batch
 * became the edits listed below.
 *
 * `node tests/tools/print-edit-batches.mjs <name>` prints a recording's
 * batches, one per line.
 */

const times = ( count: number, summary: string ): string[] =>
	new Array( count ).fill( summary );

const TRANSFORM = 'transform_block, set_attr, remove_attr';

/*
 * The edits each recording becomes, one entry per batch that holds a
 * block operation. A batch that only moves the caret, or only changes a
 * post field, has no entry.
 */
const EXPECTED: Record< string, string[] > = {
	'attribute-change': [ 'set_attr', 'set_attr', 'remove_attr' ],
	'backspace-at-start': [ 'merge_blocks' ],
	'backspace-at-start-with-block-after': [ 'merge_blocks' ],
	'bold-and-link': [ 'format_text', 'format_text' ],
	'caret-move-without-edit': [],
	// The last batch names a block id the engine has never seen. See the
	// test for it below.
	'code-editor-edit': [ '' ],
	'delete-backward-and-forward': times( 4, 'delete_text' ),
	'drag-to-reorder': [ 'move_block' ],
	duplicate: [ 'insert_block' ],
	emoji: [ 'insert_text', 'insert_text', 'delete_text', 'delete_text' ],
	'enter-at-end': [ 'insert_block', ...times( 4, 'insert_text' ) ],
	'enter-in-middle': [ 'split_block' ],
	'enter-in-middle-with-block-after': [ 'split_block' ],
	'fast-typing': times( 40, 'insert_text' ),
	// The recorder's blocks carry no saved ids, so the two grouped
	// paragraphs arrive as new blocks. With saved ids they keep their ids
	// and move (see capture.test.ts).
	'group-blocks': [ 'insert_block, remove_block x2' ],
	'heading-level-change': [ 'set_attr' ],
	'indent-list-item': [ 'insert_block, move_block' ],
	'input-method-composition': times( 2, 'insert_text' ),
	'insert-pattern': [ 'insert_block' ],
	'meta-change': [],
	// 70 blocks reported as "insert at the end, then move the block that
	// follows": 70 inserts and no move.
	'more-than-64-changes': [
		'insert_block x70',
		'insert_text',
		...times( 5, 'insert_block' ),
	],
	'move-into-group': [ 'move_block' ],
	'move-with-shortcut': [ 'move_block', 'move_block' ],
	'paste-blocks-into-empty-paragraph': [ 'insert_block x3, remove_block' ],
	'paste-blocks-into-text': [ 'insert_block, replace_text' ],
	'paste-inline-text': [ 'insert_text' ],
	'remove-block': [ 'remove_block' ],
	'replace-selection': [ 'replace_text', ...times( 4, 'insert_text' ) ],
	'reusable-block-edit': times( 5, 'insert_text' ),
	'select-all-and-delete': [ 'insert_block, remove_block x3' ],
	'slash-insert': [
		...times( 8, 'insert_text' ),
		`${ TRANSFORM }, delete_text`,
		...times( 5, 'insert_text' ),
	],
	// The engine never loads a template part, so it skips its batches.
	'template-part-edit': [],
	'title-change': [],
	'transform-in-the-middle': [ TRANSFORM ],
	'transform-paragraph-to-heading': [ TRANSFORM ],
	'transform-with-typed-prefix': [
		...times( 3, 'insert_text' ),
		`${ TRANSFORM }, delete_text`,
		...times( 5, 'insert_text' ),
	],
	'typing-at-end': times( 6, 'insert_text' ),
	'typing-inside-repeated-characters': times( 2, 'insert_text' ),
	'undo-and-redo': times( 4, 'insert_text' ),
};

/**
 * A reduced tree without its lasting ids.
 *
 * @param blocks The reduced tree.
 * @return The same tree with every id blanked.
 */
function withoutIds( blocks: ComparableBlock[] ): ComparableBlock[] {
	return blocks.map( ( block ) => ( {
		...block,
		syncId: undefined,
		children: withoutIds( block.children ),
	} ) );
}

const same = ( a: ComparableBlock[], b: ComparableBlock[] ): boolean =>
	JSON.stringify( a ) === JSON.stringify( b );

describe( 'capture, replaying recorded edit batches', () => {
	it( 'has an expectation for every recording', () => {
		expect( Object.keys( EXPECTED ).sort() ).toEqual( listRecordings() );
	} );

	it.each( listRecordings() )(
		'%s: each batch becomes the expected edits',
		( name ) => {
			const batches = replay( loadRecording( name ) );

			expect(
				batches.map( ( batch ) => summarize( batch.intents ) )
			).toEqual( EXPECTED[ name ] );
		}
	);

	it.each(
		listRecordings().filter( ( name ) => 'code-editor-edit' !== name )
	)( '%s: the document equals the editor after every batch', ( name ) => {
		const batches = replay( loadRecording( name ) );

		for ( const [ index, batch ] of batches.entries() ) {
			if ( ! batch.editor || same( batch.document, batch.editor ) ) {
				continue;
			}

			/*
			 * The recorder reads the editor's tree one task after a batch.
			 * When the next batch arrives within that task (fast typing, a
			 * typed prefix that changes the block type), the tree is
			 * already ahead. It must then equal the document after a later
			 * batch. Ids are left out: the later blocks had no id yet when
			 * the tree was reduced.
			 */
			const isAhead = batches
				.slice( index + 1 )
				.some( ( later ) =>
					same(
						withoutIds( later.document ),
						withoutIds( batch.editor ?? [] )
					)
				);

			if ( ! isAhead ) {
				expect( batch.document ).toEqual( batch.editor );
			}
		}
	} );

	it.each(
		listRecordings().filter( ( name ) => 'code-editor-edit' !== name )
	)( '%s: nothing unexpected is counted', ( name ) => {
		for ( const batch of replay( loadRecording( name ) ) ) {
			expect( batch.counters ).toEqual( {
				stalePreviousValue: 0,
				caretFallback: 0,
				unknownClientId: 0,
				droppedIntents: 0,
			} );
		}
	} );

	it( 'places a typed character by the caret, not by comparing the ends', () => {
		// "a" typed after the first "a" of "aaa". Comparing the ends would
		// place it at 3.
		const [ first ] = replay(
			loadRecording( 'typing-inside-repeated-characters' )
		);

		expect( first.intents ).toEqual( [
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
	} );

	it( 'keeps an emoji whole', () => {
		// "Hi 😀 there": insert 😁 after the first emoji, type "x", then
		// press Backspace twice. An emoji takes two units.
		const payloads = replay( loadRecording( 'emoji' ) ).map(
			( batch ) => batch.intents[ 0 ].payload
		);

		expect( payloads ).toEqual( [
			{ syncId: 'b1', field: 'content', offset: 5, text: '\u{1F601}' },
			{ syncId: 'b1', field: 'content', offset: 7, text: 'x' },
			{
				syncId: 'b1',
				field: 'content',
				start: 7,
				end: 8,
				removedText: 'x',
			},
			{
				syncId: 'b1',
				field: 'content',
				start: 5,
				end: 7,
				removedText: '\u{1F601}',
			},
		] );
	} );

	it( 'reports Enter in the middle of a paragraph as a split', () => {
		const [ batch ] = replay(
			loadRecording( 'enter-in-middle-with-block-after' )
		);

		// "Hello world" becomes "Hello" and a new block " world". The new
		// block gets a new lasting id, which the editor has yet to learn.
		expect( batch.intents ).toEqual( [
			{
				type: 'split_block',
				payload: {
					syncId: 'b1',
					field: 'content',
					offset: 5,
					newSyncId: 'b3',
				},
			},
		] );
		expect( batch.identityNeedsWrite ).toBe( true );
	} );

	it( 'reports Backspace at the start of a paragraph as a merge', () => {
		const [ batch ] = replay(
			loadRecording( 'backspace-at-start-with-block-after' )
		);

		expect( batch.intents ).toEqual( [
			{
				type: 'merge_blocks',
				payload: {
					survivorId: 'b1',
					absorbedId: 'b2',
					field: 'content',
					joinOffset: 6,
				},
			},
		] );
	} );

	it( 'keeps the block id when the block type changes, and moves nothing', () => {
		// Gutenberg reports: a heading inserted at the end, the paragraph
		// removed, and the block after it moved to the end.
		const [ batch ] = replay( loadRecording( 'transform-in-the-middle' ) );

		expect( batch.intents[ 0 ] ).toEqual( {
			type: 'transform_block',
			payload: { syncId: 'b2', newBlockType: 'core/heading' },
		} );
		expect( batch.doc.root.map( ( block ) => block.syncId ) ).toEqual( [
			'b1',
			'b2',
			'b3',
		] );
	} );

	it( 'moves an indented list item and keeps its id', () => {
		// Gutenberg reports: the item removed, then a new list inserted
		// that holds the same item under the same clientId.
		const [ batch ] = replay( loadRecording( 'indent-list-item' ) );
		const [ insert, move ] = batch.intents;

		expect( insert.type ).toBe( 'insert_block' );
		expect( insert.payload.block ).toMatchObject( {
			blockType: 'core/list',
			children: [],
		} );
		expect( move ).toEqual( {
			type: 'move_block',
			payload: {
				syncId: 'b3',
				newParentId: 'b4',
				afterSiblingId: null,
			},
		} );
	} );

	it( 'does nothing with a batch that names a block id it does not know', () => {
		// After an edit in the code editor, the editor parses the content
		// again and every block gets a new clientId. Capture never guesses
		// which block is meant. It counts the event.
		const [ batch ] = replay( loadRecording( 'code-editor-edit' ) );

		expect( batch.intents ).toEqual( [] );
		expect( batch.counters.unknownClientId ).toBe( 1 );
	} );
} );
