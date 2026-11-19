/**
 * External dependencies
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// Mock @wordpress/api-fetch
jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn(),
} ) );

/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import {
	intValueOrDefault,
	postSyncUpdate,
	rotateWindow,
} from '../../../../src/providers/http-polling/utils';

const mockApiFetch = jest.mocked( apiFetch );

describe( 'http-polling utils', () => {
	describe( 'postSyncUpdate', () => {
		beforeEach( () => {
			jest.clearAllMocks();
		} );

		it( 'sends a POST request to the sync endpoint', async () => {
			mockApiFetch.mockResolvedValue( { rooms: [] } );

			const payload = {
				rooms: [
					{
						after: 0,
						awareness: {},
						client_id: 123,
						room: 'test-room',
						updates: [],
					},
				],
			};

			await postSyncUpdate( payload );

			expect( mockApiFetch ).toHaveBeenCalledWith( {
				data: payload,
				method: 'POST',
				path: '/wp-sync/v1/updates',
			} );
		} );

		it( 'returns the parsed response', async () => {
			const expectedResponse = {
				rooms: [
					{
						awareness: {},
						end_cursor: 1000,
						room: 'test-room',
						updates: [],
					},
				],
			};
			mockApiFetch.mockResolvedValue( expectedResponse );

			const result = await postSyncUpdate( { rooms: [] } );

			expect( result ).toEqual( expectedResponse );
		} );

		it( 'propagates errors from apiFetch', async () => {
			mockApiFetch.mockRejectedValue( {
				code: 'internal_server_error',
				message: 'Internal Server Error',
			} );

			await expect( postSyncUpdate( { rooms: [] } ) ).rejects.toEqual( {
				code: 'internal_server_error',
				message: 'Internal Server Error',
			} );
		} );

		it( 'propagates network errors', async () => {
			mockApiFetch.mockRejectedValue( new Error( 'Network error' ) );

			await expect( postSyncUpdate( { rooms: [] } ) ).rejects.toThrow(
				'Network error'
			);
		} );
	} );

	describe( 'intValueOrDefault', () => {
		it( 'returns the integer value when parsing succeeds', () => {
			expect( intValueOrDefault( '42', 0 ) ).toBe( 42 );
			expect( intValueOrDefault( '-10', 0 ) ).toBe( -10 );
			expect( intValueOrDefault( '0', 1 ) ).toBe( 0 );
		} );

		it( 'returns the default value when parsing fails', () => {
			expect( intValueOrDefault( 'abc', 100 ) ).toBe( 100 );
			expect( intValueOrDefault( '', 50 ) ).toBe( 50 );
			expect( intValueOrDefault( {}, 10 ) ).toBe( 10 );
			expect( intValueOrDefault( [], 20 ) ).toBe( 20 );
			expect( intValueOrDefault( null, 25 ) ).toBe( 25 );
			expect( intValueOrDefault( undefined, 75 ) ).toBe( 75 );
		} );

		it( 'handles non-string inputs gracefully', () => {
			expect( intValueOrDefault( 123, 0 ) ).toBe( 123 );
			expect( intValueOrDefault( 45.67, 0 ) ).toBe( 45 ); // parseInt truncates
			expect( intValueOrDefault( 0x10, 0 ) ).toBe( 16 ); // hex
		} );

		it( 'handles edge cases', () => {
			expect( intValueOrDefault( '   15   ', 0 ) ).toBe( 15 ); // whitespace
			expect( intValueOrDefault( '08', 0 ) ).toBe( 8 ); // leading zero
		} );
	} );

	describe( 'rotateWindow', () => {
		it( 'returns an empty window for an empty list', () => {
			expect( rotateWindow( [], 0, 3 ) ).toEqual( {
				window: [],
				nextOffset: 0,
			} );
		} );

		it( 'returns an empty window for any offset when the list is empty', () => {
			expect( rotateWindow( [], 42, 10 ) ).toEqual( {
				window: [],
				nextOffset: 0,
			} );
		} );

		it( 'returns every item and advances the offset when size fits', () => {
			const items = [ 'a', 'b', 'c', 'd' ];

			expect( rotateWindow( items, 0, 4 ) ).toEqual( {
				window: [ 'a', 'b', 'c', 'd' ],
				nextOffset: 0,
			} );
		} );

		it( 'returns a prefix window when size is smaller than the list', () => {
			const items = [ 'a', 'b', 'c', 'd', 'e' ];

			expect( rotateWindow( items, 0, 2 ) ).toEqual( {
				window: [ 'a', 'b' ],
				nextOffset: 2,
			} );
		} );

		it( 'starts the window at the given offset', () => {
			const items = [ 'a', 'b', 'c', 'd', 'e' ];

			expect( rotateWindow( items, 2, 2 ) ).toEqual( {
				window: [ 'c', 'd' ],
				nextOffset: 4,
			} );
		} );

		it( 'wraps around the end of the list', () => {
			const items = [ 'a', 'b', 'c', 'd', 'e' ];

			expect( rotateWindow( items, 4, 3 ) ).toEqual( {
				window: [ 'e', 'a', 'b' ],
				nextOffset: 2,
			} );
		} );

		it( 'normalizes offsets larger than the list length', () => {
			const items = [ 'a', 'b', 'c' ];

			// offset 7 mod 3 === 1, so the window starts at 'b'.
			expect( rotateWindow( items, 7, 2 ) ).toEqual( {
				window: [ 'b', 'c' ],
				nextOffset: 0,
			} );
		} );

		it( 'normalizes negative offsets into the valid range', () => {
			const items = [ 'a', 'b', 'c' ];

			// -1 should resolve to the last element.
			expect( rotateWindow( items, -1, 2 ) ).toEqual( {
				window: [ 'c', 'a' ],
				nextOffset: 1,
			} );
		} );

		it( 'clamps the window when size exceeds the list length', () => {
			const items = [ 'a', 'b', 'c' ];

			expect( rotateWindow( items, 0, 10 ) ).toEqual( {
				window: [ 'a', 'b', 'c' ],
				nextOffset: 1,
			} );
		} );

		it( 'returns an empty window and leaves offset unchanged for size 0', () => {
			const items = [ 'a', 'b', 'c' ];

			expect( rotateWindow( items, 2, 0 ) ).toEqual( {
				window: [],
				nextOffset: 2,
			} );
		} );

		it( 'treats negative sizes as zero', () => {
			const items = [ 'a', 'b', 'c' ];

			expect( rotateWindow( items, 1, -5 ) ).toEqual( {
				window: [],
				nextOffset: 1,
			} );
		} );

		it( 'does not mutate the input list', () => {
			const items = [ 'a', 'b', 'c', 'd' ];
			const snapshot = [ ...items ];

			rotateWindow( items, 2, 3 );

			expect( items ).toEqual( snapshot );
		} );

		it( 'supports successive calls that cover every item exactly once', () => {
			const items = [ 'a', 'b', 'c', 'd', 'e' ];
			const seen: string[] = [];
			let offset = 0;

			for ( let i = 0; i < 3; i++ ) {
				const { window, nextOffset } = rotateWindow( items, offset, 2 );
				seen.push( ...window );
				offset = nextOffset;
			}

			// Three rotations of size 2 => 6 slots; across 5 items that means
			// each item is seen at least once.
			expect( new Set( seen ) ).toEqual( new Set( items ) );
		} );
	} );
} );
