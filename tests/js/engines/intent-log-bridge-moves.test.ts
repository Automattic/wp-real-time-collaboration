/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import {
	blockOrder,
	captureEdits,
	documentFromBlocks,
	editsFrom,
	paragraph,
} from '../known-defects/helpers';

/*
 * The engine records each block's place as "the block before me". When a
 * new block goes in front of block X, the block before X changes, and X
 * still did not move. The comparison of two documents (deriveIntents in
 * src/engines/intent-log-bridge.ts) must not report "X moved": that would
 * tell everyone else to put X right after the new block, which pulls X in
 * front of anything another person put there at the same time.
 *
 * The capture of editor edits has its own tests in tests/js/editor/.
 */

describe( 'comparison of two documents: which blocks move', () => {
	it( 'captures a new block as one insert and no move', () => {
		const doc = documentFromBlocks( [
			paragraph( 'w', 'W' ),
			paragraph( 'x', 'X' ),
		] );

		const edits = captureEdits( doc, [
			paragraph( 'w', 'W' ),
			paragraph( 'new', 'New' ),
			paragraph( 'x', 'X' ),
		] );

		expect( edits.map( ( edit ) => edit.type ) ).toEqual( [
			'insert_block',
		] );
	} );

	// What a person sees. Alice and Bob each put a new block in front of
	// X at the same time. Each of them expects X to stay below the new
	// block. The extra moves put X between the two new blocks.
	it( 'keeps the next block after both new blocks when two people insert at the same spot', () => {
		const doc = documentFromBlocks( [
			paragraph( 'w', 'W' ),
			paragraph( 'x', 'X' ),
		] );
		const server = createServer( doc );

		const fromAlice = editsFrom(
			captureEdits( doc, [
				paragraph( 'w', 'W' ),
				paragraph( 'a', 'From Alice' ),
				paragraph( 'x', 'X' ),
			] ),
			'alice'
		);
		const fromBob = editsFrom(
			captureEdits( doc, [
				paragraph( 'w', 'W' ),
				paragraph( 'b', 'From Bob' ),
				paragraph( 'x', 'X' ),
			] ),
			'bob'
		);
		const verdicts = [
			...serverIngestBatch( server, fromAlice ),
			...serverIngestBatch( server, fromBob ),
		];

		// Nothing here is a conflict, so nothing is set aside.
		expect(
			verdicts.every( ( verdict ) => 'applied' === verdict.status )
		).toBe( true );
		expect( server.proposals ).toHaveLength( 0 );

		const order = blockOrder( serverDocAt( server, server.log.length ) );
		expect( [ ...order ].sort() ).toEqual( [ 'a', 'b', 'w', 'x' ] );
		expect( order[ 0 ] ).toBe( 'w' );
		// X stays after both new blocks, whichever of the two is first.
		expect( order.indexOf( 'x' ) ).toBe( 3 );
	} );

	it( 'moves one block when one block changed place', () => {
		const doc = documentFromBlocks( [
			paragraph( 'a', 'A' ),
			paragraph( 'b', 'B' ),
			paragraph( 'c', 'C' ),
			paragraph( 'd', 'D' ),
		] );

		// D went to the front. A, B and C each have a new block before
		// them or keep theirs, and none of them moved.
		const edits = captureEdits( doc, [
			paragraph( 'd', 'D' ),
			paragraph( 'a', 'A' ),
			paragraph( 'b', 'B' ),
			paragraph( 'c', 'C' ),
		] );

		expect( edits ).toEqual( [
			{
				type: 'move_block',
				payload: {
					syncId: 'd',
					newParentId: null,
					afterSiblingId: null,
				},
			},
		] );
	} );

	it( 'reaches the new order when blocks are added, removed and moved at once', () => {
		const doc = documentFromBlocks( [
			paragraph( 'a', 'A' ),
			paragraph( 'b', 'B' ),
			paragraph( 'c', 'C' ),
			paragraph( 'd', 'D' ),
		] );
		const server = createServer( doc );

		serverIngestBatch(
			server,
			editsFrom(
				captureEdits( doc, [
					paragraph( 'c', 'C' ),
					paragraph( 'new', 'New' ),
					paragraph( 'a', 'A' ),
					paragraph( 'd', 'D' ),
				] ),
				'alice'
			)
		);

		expect(
			blockOrder( serverDocAt( server, server.log.length ) )
		).toEqual( [ 'c', 'new', 'a', 'd' ] );
	} );
} );
