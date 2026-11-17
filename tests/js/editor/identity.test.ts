/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createBlockIdentityTable } from '../../../src/editor/identity';

describe( 'the block id table', () => {
	it( 'looks a link up from both sides', () => {
		const ids = createBlockIdentityTable();

		ids.link( 'client-1', 'sync-1' );

		expect( ids.getSyncId( 'client-1' ) ).toBe( 'sync-1' );
		expect( ids.getClientId( 'sync-1' ) ).toBe( 'client-1' );
		expect( ids.size() ).toBe( 1 );
	} );

	it( 'knows nothing about an id it was never given', () => {
		const ids = createBlockIdentityTable();

		expect( ids.getSyncId( 'client-1' ) ).toBeUndefined();
		expect( ids.getClientId( 'sync-1' ) ).toBeUndefined();
	} );

	it( 'drops the old link when a document block gets a new editor id', () => {
		// A change of block type: the document block lives on under the
		// editor's new block.
		const ids = createBlockIdentityTable();

		ids.link( 'client-old', 'sync-1' );
		ids.link( 'client-new', 'sync-1' );

		expect( ids.getClientId( 'sync-1' ) ).toBe( 'client-new' );
		expect( ids.getSyncId( 'client-old' ) ).toBeUndefined();
		expect( ids.size() ).toBe( 1 );
	} );

	it( 'drops the old link when an editor block gets a new document id', () => {
		const ids = createBlockIdentityTable();

		ids.link( 'client-1', 'sync-old' );
		ids.link( 'client-1', 'sync-new' );

		expect( ids.getSyncId( 'client-1' ) ).toBe( 'sync-new' );
		expect( ids.getClientId( 'sync-old' ) ).toBeUndefined();
		expect( ids.size() ).toBe( 1 );
	} );

	it( 'forgets a removed document block', () => {
		const ids = createBlockIdentityTable();

		ids.link( 'client-1', 'sync-1' );
		ids.link( 'client-2', 'sync-2' );
		ids.unlinkSyncId( 'sync-1' );

		expect( ids.getSyncId( 'client-1' ) ).toBeUndefined();
		expect( ids.getClientId( 'sync-1' ) ).toBeUndefined();
		expect( ids.getSyncId( 'client-2' ) ).toBe( 'sync-2' );
	} );

	it( 'forgets everything', () => {
		const ids = createBlockIdentityTable();

		ids.link( 'client-1', 'sync-1' );
		ids.clear();

		expect( ids.size() ).toBe( 0 );
		expect( ids.getSyncId( 'client-1' ) ).toBeUndefined();
	} );
} );
