/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createDocument } from '../../../src/engines/intent-log/document.js';
import type { EditorBlock } from '../../../src/editor/gutenberg-contract';
import { createBlockIdentityTable } from '../../../src/editor/identity';
import { linkLoadedBlocks } from '../../../src/editor/load';

/**
 * An editor block.
 *
 * @param clientId    The editor's id for the block.
 * @param name        The block type.
 * @param syncId      The lasting id saved in the block, if any.
 * @param innerBlocks The children.
 * @return The block.
 */
function block(
	clientId: string,
	name: string,
	syncId?: string,
	innerBlocks: EditorBlock[] = []
): EditorBlock {
	const attributes: Record< string, unknown > = {};

	if ( syncId ) {
		attributes.metadata = { syncId };
	}

	return { clientId, name, attributes, innerBlocks };
}

describe( 'matching the editor’s blocks to the document when a post opens', () => {
	it( 'links a block by the lasting id saved in it, wherever it is', () => {
		// The saved post is newer than the document in one way: the two
		// paragraphs changed places.
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph' },
			{ syncId: 'p2', blockType: 'core/paragraph' },
		] );

		const match = linkLoadedBlocks(
			ids,
			[
				block( 'c-a', 'core/paragraph', 'p2' ),
				block( 'c-b', 'core/paragraph', 'p1' ),
			],
			doc
		);

		expect( ids.getSyncId( 'c-a' ) ).toBe( 'p2' );
		expect( ids.getSyncId( 'c-b' ) ).toBe( 'p1' );
		expect( match ).toEqual( {
			bySavedId: 2,
			byPosition: 0,
			unmatched: 0,
		} );
	} );

	it( 'links blocks with no saved id by their place and type', () => {
		// A post nobody has edited together yet.
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'g-0', blockType: 'core/heading' },
			{
				syncId: 'g-1',
				blockType: 'core/group',
				children: [ { syncId: 'g-1-0', blockType: 'core/paragraph' } ],
			},
		] );

		const match = linkLoadedBlocks(
			ids,
			[
				block( 'c-heading', 'core/heading' ),
				block( 'c-group', 'core/group', undefined, [
					block( 'c-inner', 'core/paragraph' ),
				] ),
			],
			doc
		);

		expect( ids.getSyncId( 'c-heading' ) ).toBe( 'g-0' );
		expect( ids.getSyncId( 'c-group' ) ).toBe( 'g-1' );
		expect( ids.getSyncId( 'c-inner' ) ).toBe( 'g-1-0' );
		expect( match ).toEqual( {
			bySavedId: 0,
			byPosition: 3,
			unmatched: 0,
		} );
	} );

	it( 'does not link by place when the block type differs', () => {
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'g-0', blockType: 'core/heading' },
		] );

		const match = linkLoadedBlocks(
			ids,
			[ block( 'c-1', 'core/paragraph' ) ],
			doc
		);

		expect( ids.getSyncId( 'c-1' ) ).toBeUndefined();
		expect( match.unmatched ).toBe( 1 );
	} );

	it( 'does not give a block by place the document block another block names', () => {
		// The first editor block is new and has no id. The second carries
		// the id of the document's first block.
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph' },
		] );

		linkLoadedBlocks(
			ids,
			[
				block( 'c-new', 'core/paragraph' ),
				block( 'c-known', 'core/paragraph', 'p1' ),
			],
			doc
		);

		expect( ids.getSyncId( 'c-known' ) ).toBe( 'p1' );
		expect( ids.getSyncId( 'c-new' ) ).toBeUndefined();
	} );

	it( 'ignores a saved id the document does not hold', () => {
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph' },
		] );

		const match = linkLoadedBlocks(
			ids,
			[ block( 'c-1', 'core/paragraph', 'from-another-post' ) ],
			doc
		);

		// It still matches by its place.
		expect( ids.getSyncId( 'c-1' ) ).toBe( 'p1' );
		expect( match ).toEqual( {
			bySavedId: 0,
			byPosition: 1,
			unmatched: 0,
		} );
	} );

	it( 'gives the same saved id to the first block only', () => {
		const ids = createBlockIdentityTable();
		const doc = createDocument( [
			{ syncId: 'p1', blockType: 'core/paragraph' },
		] );

		const match = linkLoadedBlocks(
			ids,
			[
				block( 'c-first', 'core/paragraph', 'p1' ),
				block( 'c-copy', 'core/paragraph', 'p1' ),
			],
			doc
		);

		expect( ids.getSyncId( 'c-first' ) ).toBe( 'p1' );
		expect( ids.getSyncId( 'c-copy' ) ).toBeUndefined();
		expect( match ).toEqual( {
			bySavedId: 1,
			byPosition: 0,
			unmatched: 1,
		} );
	} );

	it( 'does not match the children of a block that has no counterpart', () => {
		const ids = createBlockIdentityTable();
		const doc = createDocument( [] );

		const match = linkLoadedBlocks(
			ids,
			[
				block( 'c-group', 'core/group', undefined, [
					block( 'c-inner', 'core/paragraph' ),
				] ),
			],
			doc
		);

		expect( ids.size() ).toBe( 0 );
		expect( match.unmatched ).toBe( 2 );
	} );
} );
