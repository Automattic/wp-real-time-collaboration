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
} from './helpers';

/*
 * Known defect, plan item 3 under "What is fragile today".
 *
 * The engine records each block's place as "the block before me". When a
 * new block goes in front of block X, the block before X changes, so the
 * capture also reports "X moved" (deriveIntents in
 * src/engines/intent-log-bridge.ts). X did not move. The extra move tells
 * everyone else to put X right after the new block, which pulls X in
 * front of anything another person put there at the same time.
 */

describe( 'known defect: the extra move after an insert', () => {
	it.failing(
		'captures a new block as one insert and no move (known defect, fixed in Phase 3)',
		() => {
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
		}
	);

	// What a person sees. Alice and Bob each put a new block in front of
	// X at the same time. Each of them expects X to stay below the new
	// block. The extra moves put X between the two new blocks.
	it.failing(
		'keeps the next block after both new blocks when two people insert at the same spot (known defect, fixed in Phase 3)',
		() => {
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

			const order = blockOrder(
				serverDocAt( server, server.log.length )
			);
			expect( [ ...order ].sort() ).toEqual( [ 'a', 'b', 'w', 'x' ] );
			expect( order[ 0 ] ).toBe( 'w' );
			// X stays after both new blocks, whichever of the two is first.
			expect( order.indexOf( 'x' ) ).toBe( 3 );
		}
	);
} );
