/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createDocument } from '../../../src/engines/intent-log/document.js';
import type { EngineDocument } from '../../../src/engines/intent-log/engine-types';
import {
	addPostFieldTaxonomies,
	capturePostFields,
	createPostFieldsState,
	fieldChangesFrom,
	forgetSeenPostFields,
	postFieldEditsToPush,
	serverChangedFields,
} from '../../../src/editor/post-fields';

/**
 * A document that holds only properties.
 *
 * @param props    The property values.
 * @param versions How often each property was written.
 * @return The document.
 */
function documentWith(
	props: Record< string, unknown >,
	versions: Record< string, number > = {}
): EngineDocument {
	const doc = createDocument( [], props );

	doc.propVersions = versions;

	return doc;
}

const record = {
	title: { raw: 'Hello', rendered: 'Hello' },
	excerpt: { raw: '', rendered: '' },
	status: 'draft',
	slug: 'hello',
	categories: [ 3, 1 ],
	meta: { footnotes: '', subtitle: 'Old' },
};

describe( 'post fields: editor to document', () => {
	it( 'turns a changed title into one set_property edit', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { title: 'Hello' }, { title: 2 } );

		expect( capturePostFields( doc, { title: 'Hello!' }, state ) ).toEqual(
			[
				{
					type: 'set_property',
					payload: {
						name: 'title',
						value: 'Hello!',
						observedVersion: 2,
					},
				},
			]
		);
	} );

	it( 'skips a value the document already holds', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { title: 'Hello' } );

		expect( capturePostFields( doc, { title: 'Hello' }, state ) ).toEqual(
			[]
		);
	} );

	it( 'ignores a field the record does not sync', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( {} );

		expect(
			capturePostFields(
				doc,
				{ content: '<p>Raw</p>', password: 'x' },
				state
			)
		).toEqual( [] );
	} );

	it( 'reads a title given as raw and rendered text', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { title: 'Hello' } );

		const [ intent ] = capturePostFields(
			doc,
			{ title: { raw: 'From the server', rendered: 'From the server' } },
			state
		);

		expect( intent.payload.value ).toBe( 'From the server' );
	} );

	it( 'does not let the placeholder title of a new post replace an empty title', () => {
		const state = createPostFieldsState( {
			title: { raw: 'Auto Draft' },
			status: 'auto-draft',
		} );
		const doc = documentWith( { title: '' } );

		expect(
			capturePostFields( doc, { title: 'Auto Draft' }, state )
		).toEqual( [] );
	} );

	it( 'never syncs the auto-draft status or an empty slug', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { status: 'draft', slug: 'hello' } );

		expect(
			capturePostFields( doc, { status: 'auto-draft', slug: '' }, state )
		).toEqual( [] );
	} );

	it( 'syncs a taxonomy of the post type, with the term ids sorted', () => {
		const state = createPostFieldsState( record, [ 'categories' ] );
		const doc = documentWith( { categories: [ 1, 3 ] } );

		expect(
			capturePostFields( doc, { categories: [ 7, 3, 1 ] }, state )
		).toEqual( [
			{
				type: 'set_property',
				payload: {
					name: 'categories',
					value: [ 1, 3, 7 ],
					observedVersion: 0,
				},
			},
		] );
	} );

	it( 'does not treat the same terms in another order as a change', () => {
		const state = createPostFieldsState( record, [ 'categories' ] );
		const doc = documentWith( { categories: [ 1, 3 ] } );

		expect(
			capturePostFields( doc, { categories: [ 3, 1 ] }, state )
		).toEqual( [] );
	} );

	it( 'sends one edit per changed meta key', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( {
			'meta.footnotes': '',
			'meta.subtitle': 'Old',
		} );

		expect(
			capturePostFields(
				doc,
				{ meta: { footnotes: '', subtitle: 'New' } },
				state
			)
		).toEqual( [
			{
				type: 'set_property',
				payload: {
					name: 'meta.subtitle',
					value: 'New',
					observedVersion: 0,
				},
			},
		] );
	} );

	it( 'does not send a meta key that did not change, even when the document lacks it', () => {
		// The editor sends the whole meta object with every change. A key
		// the room has never held must not go out next to the one the
		// person changed.
		const state = createPostFieldsState( record );
		const doc = documentWith( {} );
		const { changes, previous } = fieldChangesFrom( [
			{
				type: 'set-field',
				field: 'meta',
				previousValue: { footnotes: '', subtitle: 'Old' },
				value: { footnotes: '', subtitle: 'New' },
			},
		] );

		const intents = capturePostFields( doc, changes, state, previous );

		expect( intents.map( ( intent ) => intent.payload.name ) ).toEqual( [
			'meta.subtitle',
		] );
	} );

	it( 'never syncs the meta key that stores another engine’s document', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( {} );

		expect(
			capturePostFields( doc, { meta: { _crdt_document: 'abc' } }, state )
		).toEqual( [] );
	} );

	it( 'treats an empty list and an empty object in meta as the same value', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { 'meta.settings': [] } );

		expect(
			capturePostFields( doc, { meta: { settings: {} } }, state )
		).toEqual( [] );
	} );

	it( 'keeps the first old value when a batch changes a field twice', () => {
		expect(
			fieldChangesFrom( [
				{
					type: 'set-field',
					field: 'title',
					previousValue: 'A',
					value: 'B',
				},
				{
					type: 'set-field',
					field: 'title',
					previousValue: 'B',
					value: 'C',
				},
			] )
		).toEqual( { changes: { title: 'C' }, previous: { title: 'A' } } );
	} );
} );

describe( 'post fields: document to editor', () => {
	it( 'pushes nothing when the document equals the record the editor loaded', () => {
		const state = createPostFieldsState( record, [ 'categories' ] );
		const doc = documentWith( {
			title: 'Hello',
			excerpt: '',
			status: 'draft',
			slug: 'hello',
			categories: [ 1, 3 ],
			'meta.footnotes': '',
			'meta.subtitle': 'Old',
		} );

		expect( postFieldEditsToPush( doc, state ) ).toBeNull();
	} );

	it( 'pushes a value that someone else changed, once', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { title: 'Changed by Bob' } );

		expect( postFieldEditsToPush( doc, state ) ).toEqual( {
			title: 'Changed by Bob',
		} );
		expect( postFieldEditsToPush( doc, state ) ).toBeNull();
	} );

	it( 'does not push back a value the editor just sent', () => {
		const state = createPostFieldsState( record );
		const before = documentWith( { title: 'Hello' } );

		capturePostFields( before, { title: 'Mine' }, state );

		expect(
			postFieldEditsToPush( documentWith( { title: 'Mine' } ), state )
		).toBeNull();
	} );

	it( 'pushes a new post’s empty title over the stored placeholder only when it differs', () => {
		const state = createPostFieldsState( {
			title: { raw: 'Auto Draft' },
			status: 'auto-draft',
		} );

		expect(
			postFieldEditsToPush( documentWith( { title: '' } ), state )
		).toBeNull();
	} );

	it( 'never pushes the auto-draft status or a value a field cannot hold', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( {
			status: 'auto-draft',
			title: { not: 'text' },
		} );

		expect( postFieldEditsToPush( doc, state ) ).toBeNull();
	} );

	it( 'pushes a changed meta key together with the keys that did not change', () => {
		// `editRecord` replaces meta as a whole.
		const state = createPostFieldsState( record );
		const doc = documentWith( {
			'meta.footnotes': '',
			'meta.subtitle': 'From Bob',
		} );

		expect( postFieldEditsToPush( doc, state ) ).toEqual( {
			meta: { footnotes: '', subtitle: 'From Bob' },
		} );
	} );

	it( 'does not push a meta key this post does not have', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { 'meta.unknown_key': 'value' } );

		expect( postFieldEditsToPush( doc, state ) ).toBeNull();
	} );

	it( 'compares everything again after the room starts from a newer copy', () => {
		const state = createPostFieldsState( record );
		const doc = documentWith( { title: 'Hello' } );

		expect( postFieldEditsToPush( doc, state ) ).toBeNull();

		forgetSeenPostFields( state );

		expect( postFieldEditsToPush( doc, state ) ).toEqual( {
			title: 'Hello',
		} );
	} );
} );

describe( 'post fields: taxonomies that are looked up after the record loads', () => {
	it( 'syncs a taxonomy once it is added, and does not push the record’s own terms', () => {
		const state = createPostFieldsState( record );

		addPostFieldTaxonomies( state, record, [ 'categories' ] );

		// The room holds the terms the editor loaded: nothing to push.
		expect(
			postFieldEditsToPush(
				documentWith( { categories: [ 1, 3 ] } ),
				state
			)
		).toBeNull();
		// A change is captured.
		expect(
			capturePostFields(
				documentWith( { categories: [ 1, 3 ] } ),
				{ categories: [ 1 ] },
				state
			)
		).toHaveLength( 1 );
	} );

	it( 'adds a taxonomy once', () => {
		const state = createPostFieldsState( record );

		addPostFieldTaxonomies( state, record, [ 'categories' ] );
		addPostFieldTaxonomies( state, record, [ 'categories' ] );

		expect(
			state.syncedFields.filter( ( name ) => 'categories' === name )
		).toHaveLength( 1 );
	} );
} );

describe( 'post fields: what the server changed on save', () => {
	it( 'finds a field the server changed by itself', () => {
		expect(
			serverChangedFields(
				{ slug: 'hello-2', status: 'publish' },
				{ slug: 'hello', status: 'draft' },
				{ status: 'publish' }
			)
		).toEqual( { slug: 'hello-2' } );
	} );

	it( 'compares raw text with the plain text the browser sent', () => {
		expect(
			serverChangedFields(
				{ title: { raw: 'Hello', rendered: 'Hello' } },
				{ title: { raw: 'Old', rendered: 'Old' } },
				{ title: 'Hello' }
			)
		).toEqual( {} );
	} );

	it( 'compares meta one key at a time', () => {
		expect(
			serverChangedFields(
				{ meta: { views: 2, subtitle: 'Sent', footnotes: '' } },
				{ meta: { views: 1, subtitle: 'Old', footnotes: '' } },
				{ meta: { subtitle: 'Sent' } }
			)
		).toEqual( { meta: { views: 2 } } );
	} );

	it( 'leaves out meta when no key changed', () => {
		expect(
			serverChangedFields(
				{ meta: { footnotes: '' } },
				{ meta: { footnotes: '' } },
				{}
			)
		).toEqual( {} );
	} );
} );
