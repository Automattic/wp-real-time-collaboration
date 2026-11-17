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
	captureEdits,
	contentText,
	documentFromBlocks,
	editsFrom,
	paragraph,
	type CapturedEdit,
} from '../known-defects/helpers';

/*
 * An emoji takes two UTF-16 units, and two different emoji can share
 * their first unit. A comparison that goes one unit at a time can stop in
 * the middle of one, and the edit then holds half an emoji. The engine
 * compares whole characters (src/editor/text-change.ts), so an edit never
 * starts or ends inside one.
 *
 * These tests go through the comparison of two documents
 * (deriveIntents in src/engines/intent-log-bridge.ts). The capture of
 * editor edits has its own tests in tests/js/editor/.
 */

const GRIN = '\u{1F600}';
const BEAM = '\u{1F601}';

const isFirstHalf = ( unit: number ) => unit >= 0xd800 && unit <= 0xdbff;
const isSecondHalf = ( unit: number ) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Whether a position falls between the two halves of one character.
 *
 * @param text     The text the position refers to.
 * @param position The position, in UTF-16 units.
 * @return Whether the position cuts a character.
 */
function cutsACharacter( text: string, position: number ): boolean {
	return (
		position > 0 &&
		position < text.length &&
		isFirstHalf( text.charCodeAt( position - 1 ) ) &&
		isSecondHalf( text.charCodeAt( position ) )
	);
}

/**
 * Whether a text holds half of a two-unit character with no partner.
 *
 * @param text The text.
 * @return Whether the text holds a lone half.
 */
function hasHalfCharacter( text: string ): boolean {
	for ( let index = 0; index < text.length; index++ ) {
		const unit = text.charCodeAt( index );
		if ( isFirstHalf( unit ) ) {
			if ( ! isSecondHalf( text.charCodeAt( index + 1 ) ) ) {
				return true;
			}
			index++;
			continue;
		}

		if ( isSecondHalf( unit ) ) {
			return true;
		}
	}

	return false;
}

/**
 * Lists what is wrong with a captured text edit, if anything.
 *
 * @param edit   The captured edit.
 * @param before The text the edit was made against.
 * @return One line per problem.
 */
function halfCharacterProblems( edit: CapturedEdit, before: string ): string[] {
	const problems: string[] = [];
	for ( const name of [ 'offset', 'start', 'end' ] ) {
		const position = edit.payload[ name ];
		if (
			'number' === typeof position &&
			cutsACharacter( before, position )
		) {
			problems.push(
				`${ edit.type }: ${ name } ${ position } is inside a character`
			);
		}
	}

	for ( const name of [ 'text', 'removedText' ] ) {
		const text = edit.payload[ name ];
		if ( 'string' === typeof text && hasHalfCharacter( text ) ) {
			problems.push( `${ edit.type }: ${ name } holds half a character` );
		}
	}

	return problems;
}

describe( 'comparing two documents: an emoji stays whole', () => {
	// Replacing one emoji with another that shares its first half must not
	// be captured as "replace the second half only".
	it( 'does not cut an emoji in half when one emoji replaces another', () => {
		const before = `A${ GRIN }B`;
		const doc = documentFromBlocks( [ paragraph( 'p1', before ) ] );

		const edits = captureEdits( doc, [ paragraph( 'p1', `A${ BEAM }B` ) ] );

		expect( edits ).toHaveLength( 1 );
		expect( halfCharacterProblems( edits[ 0 ], before ) ).toEqual( [] );
	} );

	// Typing an emoji in front of another one must not be captured as an
	// insert that starts inside the existing emoji.
	it( 'does not cut an emoji in half when an emoji is typed before another', () => {
		const before = `A${ GRIN }B`;
		const doc = documentFromBlocks( [ paragraph( 'p1', before ) ] );

		const edits = captureEdits( doc, [
			paragraph( 'p1', `A${ BEAM }${ GRIN }B` ),
		] );

		expect( edits ).toHaveLength( 1 );
		expect( halfCharacterProblems( edits[ 0 ], before ) ).toEqual( [] );
	} );

	// What a person sees. Two people each delete a different emoji at the
	// same time. Each delete must cover one whole emoji, so that the server
	// can combine the two and both emoji are gone.
	it( 'leaves no half emoji when two people each delete a different emoji', () => {
		const doc = documentFromBlocks( [
			paragraph( 'p1', `A${ GRIN }${ BEAM }B` ),
		] );
		const server = createServer( doc );

		const fromAlice = editsFrom(
			captureEdits( doc, [ paragraph( 'p1', `A${ BEAM }B` ) ] ),
			'alice'
		);
		const fromBob = editsFrom(
			captureEdits( doc, [ paragraph( 'p1', `A${ GRIN }B` ) ] ),
			'bob'
		);
		const verdicts = [
			...serverIngestBatch( server, fromAlice ),
			...serverIngestBatch( server, fromBob ),
		];

		// Both deletes are accepted, so both emoji should be gone.
		expect( verdicts.map( ( verdict ) => verdict.status ) ).toEqual( [
			'applied',
			'applied',
		] );
		const text = contentText(
			serverDocAt( server, server.log.length ),
			'p1'
		);
		expect( hasHalfCharacter( text ) ).toBe( false );
		expect( text ).toBe( 'AB' );
	} );
} );
