/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	applyTextChange,
	findTextChange,
} from '../../../src/editor/text-change';

const GRIN = '\u{1F600}';
const BEAM = '\u{1F601}';

describe( 'findTextChange', () => {
	it( 'finds nothing when the texts are equal', () => {
		expect( findTextChange( 'same', 'same', { after: 2 } ) ).toEqual( {
			change: null,
			caretFailed: false,
		} );
	} );

	describe( 'without a caret', () => {
		it( 'finds an insert', () => {
			expect( findTextChange( 'Hello', 'Hello world' ).change ).toEqual( {
				start: 5,
				removed: '',
				inserted: ' world',
			} );
		} );

		it( 'finds a delete', () => {
			expect( findTextChange( 'Hello world', 'Hello' ).change ).toEqual( {
				start: 5,
				removed: ' world',
				inserted: '',
			} );
		} );

		it( 'finds a replacement', () => {
			expect( findTextChange( 'a cat sat', 'a dog sat' ).change ).toEqual(
				{
					start: 2,
					removed: 'cat',
					inserted: 'dog',
				}
			);
		} );

		it( 'places a repeated character at the end of the run', () => {
			// Nothing says which "a" is new, so the last one is taken.
			expect( findTextChange( 'aaa', 'aaaa' ).change ).toEqual( {
				start: 3,
				removed: '',
				inserted: 'a',
			} );
		} );
	} );

	describe( 'with the caret after the edit', () => {
		it( 'places a typed character where the caret is', () => {
			expect( findTextChange( 'aaa', 'aaaa', { after: 2 } ) ).toEqual( {
				change: { start: 1, removed: '', inserted: 'a' },
				caretFailed: false,
			} );
		} );

		it( 'places Backspace before the caret', () => {
			expect(
				findTextChange( 'aaaa', 'aaa', { after: 1 } ).change
			).toEqual( { start: 1, removed: 'a', inserted: '' } );
		} );

		it( 'places Delete after the caret', () => {
			// The caret stays at 1 and the character after it goes.
			expect(
				findTextChange( 'abbbc', 'abbc', { after: 1 } ).change
			).toEqual( { start: 1, removed: 'b', inserted: '' } );
		} );

		it( 'places pasted text', () => {
			expect(
				findTextChange( 'Hello world', 'Hello big world', {
					after: 9,
				} ).change
			).toEqual( { start: 5, removed: '', inserted: ' big' } );
		} );

		it( 'replaces the whole selection when the new text starts with the same letter', () => {
			// "world" was selected and "w" typed. Without the selection
			// this reads as "orld deleted".
			expect(
				findTextChange( 'Hello world', 'Hello w', {
					after: 7,
					before: { start: 6, end: 11 },
				} ).change
			).toEqual( { start: 6, removed: 'world', inserted: 'w' } );
		} );

		it( 'ignores a selection that does not fit the texts', () => {
			expect(
				findTextChange( 'Hello world', 'Hello w', {
					after: 7,
					before: { start: 6, end: 40 },
				} ).change
			).toEqual( { start: 7, removed: 'orld', inserted: '' } );
		} );

		it( 'falls back to comparing the ends, and says so, when the caret does not fit', () => {
			// The text after position 1 is not the same in both texts.
			expect( findTextChange( 'Hello', 'Help', { after: 1 } ) ).toEqual( {
				change: { start: 3, removed: 'lo', inserted: 'p' },
				caretFailed: true,
			} );
		} );

		it( 'falls back when the caret is outside the text', () => {
			expect(
				findTextChange( 'Hello', 'Hello!', { after: 99 } )
			).toEqual( {
				change: { start: 5, removed: '', inserted: '!' },
				caretFailed: true,
			} );
		} );
	} );

	describe( 'characters that take two units', () => {
		it( 'replaces a whole emoji when two emoji share their first half', () => {
			expect(
				findTextChange( `A${ GRIN }B`, `A${ BEAM }B` ).change
			).toEqual( { start: 1, removed: GRIN, inserted: BEAM } );
		} );

		it( 'inserts a whole emoji in front of another', () => {
			expect(
				findTextChange( `A${ GRIN }B`, `A${ BEAM }${ GRIN }B` ).change
			).toEqual( { start: 1, removed: '', inserted: BEAM } );
		} );

		it( 'deletes a whole emoji next to another', () => {
			expect(
				findTextChange( `A${ GRIN }${ BEAM }B`, `A${ BEAM }B` ).change
			).toEqual( { start: 1, removed: GRIN, inserted: '' } );
			expect(
				findTextChange( `A${ GRIN }${ BEAM }B`, `A${ GRIN }B` ).change
			).toEqual( { start: 3, removed: BEAM, inserted: '' } );
		} );

		it( 'keeps an emoji whole with a caret too', () => {
			expect(
				findTextChange( `A${ GRIN }B`, `A${ BEAM }B`, { after: 3 } )
			).toEqual( {
				change: { start: 1, removed: GRIN, inserted: BEAM },
				caretFailed: false,
			} );
		} );

		it( 'does not trust a caret between the two halves of a character', () => {
			expect(
				findTextChange( `A${ GRIN }B`, `A${ BEAM }B`, { after: 2 } )
			).toEqual( {
				change: { start: 1, removed: GRIN, inserted: BEAM },
				caretFailed: true,
			} );
		} );
	} );

	it( 'always gives a change that turns the old text into the new text', () => {
		const cases: Array< [ string, string, number | undefined ] > = [
			[ '', 'abc', 3 ],
			[ 'abc', '', 0 ],
			[ 'abab', 'ababab', 4 ],
			[ 'abab', 'ababab', 2 ],
			[ 'abab', 'ab', 0 ],
			[ `${ GRIN }${ GRIN }`, GRIN, 2 ],
			[ 'one two', 'one 2', undefined ],
			[ 'xyz', 'abc', 1 ],
		];

		for ( const [ before, after, caret ] of cases ) {
			const { change } = findTextChange( before, after, {
				after: caret,
			} );

			expect( change ).not.toBeNull();

			if ( change ) {
				expect( applyTextChange( before, change ) ).toBe( after );
			}
		}
	} );
} );
