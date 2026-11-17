/**
 * External dependencies
 */
import { describe, expect, it, jest } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	attributeDefaults,
	rawContent,
	richTextFields,
	saveMarkup,
	withAttributeDefaults,
} from '../../../src/editor/block-types';

/*
 * A stand-in for the editor's block registry. Block registration is the
 * editor's own state, so these tests describe three block types by hand.
 */
jest.mock( '@wordpress/blocks', () => {
	const types: Record< string, unknown > = {
		'core/paragraph': {
			name: 'core/paragraph',
			attributes: {
				content: { type: 'rich-text', source: 'rich-text' },
				dropCap: { type: 'boolean', default: false },
				align: { type: 'string' },
			},
		},
		'core/quote': {
			name: 'core/quote',
			attributes: {
				value: { type: 'string', source: 'html' },
				citation: { type: 'rich-text', source: 'rich-text' },
			},
		},
		'core/group': {
			name: 'core/group',
			attributes: { tagName: { type: 'string', default: 'div' } },
		},
		'test/broken': { name: 'test/broken', attributes: {} },
	};

	return {
		getBlockType: ( name: string ) => types[ name ],
		getBlockContent: ( block: {
			innerContent?: Array< string | null >;
			innerBlocks: Array< { name: string } >;
		} ) => {
			let next = 0;

			return ( block.innerContent ?? [] )
				.map(
					( piece ) =>
						piece ??
						`<!-- ${ block.innerBlocks[ next++ ]?.name } -->`
				)
				.join( '' );
		},
		getSaveContent: (
			blockType: { name: string },
			attributes: Record< string, unknown >
		) => {
			if ( 'test/broken' === blockType.name ) {
				throw new Error( 'This block cannot render.' );
			}

			if ( 'core/group' === blockType.name ) {
				return `<${ attributes.tagName } class="wp-block-group"></${ attributes.tagName }>`;
			}

			return `<p>${ attributes.content }</p>`;
		},
	};
} );

describe( 'block type helpers', () => {
	describe( 'richTextFields', () => {
		it( 'names the attributes the editor reads as rich text', () => {
			expect( richTextFields( 'core/paragraph' ) ).toEqual( [
				'content',
			] );
			expect( richTextFields( 'core/quote' ) ).toEqual( [
				'value',
				'citation',
			] );
			expect( richTextFields( 'core/group' ) ).toEqual( [] );
		} );

		it( 'takes a block type that is not registered to have a content text', () => {
			expect( richTextFields( 'plugin/missing' ) ).toEqual( [
				'content',
			] );
		} );
	} );

	describe( 'rawContent', () => {
		it( 'covers the Custom HTML and Classic blocks only', () => {
			expect( rawContent.is( 'core/html' ) ).toBe( true );
			expect( rawContent.is( 'core/freeform' ) ).toBe( true );
			expect( rawContent.is( 'core/paragraph' ) ).toBe( false );
		} );

		it( 'reads the markup pieces, with the blocks inside written in place', () => {
			expect(
				rawContent.serialize( {
					name: 'core/html',
					attributes: {},
					innerContent: [ '<div>', null, '</div>' ],
					innerBlocks: [
						{
							name: 'core/paragraph',
							attributes: {},
							innerBlocks: [],
						},
					],
				} )
			).toBe( '<div><!-- core/paragraph --></div>' );
		} );

		it( 'reads the content attribute of a block made the older way', () => {
			expect(
				rawContent.serialize( {
					name: 'core/freeform',
					attributes: { content: '<p>Classic</p>' },
					innerBlocks: [],
				} )
			).toBe( '<p>Classic</p>' );
			expect(
				rawContent.serialize( {
					name: 'core/html',
					attributes: {},
					innerBlocks: [],
				} )
			).toBe( '' );
		} );

		it( 'puts the markup back where each block keeps it', () => {
			expect( rawContent.hydrate?.( 'core/html', '<b>x</b>' ) ).toEqual( {
				innerContent: [ '<b>x</b>' ],
			} );
			expect( rawContent.hydrate?.( 'core/html', '' ) ).toEqual( {
				innerContent: [],
			} );
			expect(
				rawContent.hydrate?.( 'core/freeform', '<p>x</p>' )
			).toEqual( { attributes: { content: '<p>x</p>' } } );
		} );
	} );

	describe( 'attribute defaults', () => {
		it( 'lists the default values of a block type', () => {
			expect( attributeDefaults( 'core/paragraph' ) ).toEqual( {
				dropCap: false,
			} );
			expect( attributeDefaults( 'plugin/missing' ) ).toEqual( {} );
		} );

		it( 'adds a missing default and keeps a value that is set', () => {
			expect(
				withAttributeDefaults( 'core/paragraph', { content: 'Hi' } )
			).toEqual( { content: 'Hi', dropCap: false } );
			expect(
				withAttributeDefaults( 'core/paragraph', { dropCap: true } )
			).toEqual( { dropCap: true } );
		} );
	} );

	describe( 'saveMarkup', () => {
		it( 'renders a block that leaves out a default value it needs', () => {
			// A group reads its tag name from `tagName`. The engine's
			// document leaves the default out.
			expect(
				saveMarkup( {
					name: 'core/group',
					attributes: {},
					innerBlocks: [],
				} )
			).toBe( '<div class="wp-block-group"></div>' );
		} );

		it( 'gives nothing for a block type that is not registered', () => {
			expect(
				saveMarkup( {
					name: 'plugin/missing',
					attributes: {},
					innerBlocks: [],
				} )
			).toBeNull();
		} );

		it( 'gives nothing when the block cannot render', () => {
			expect(
				saveMarkup( {
					name: 'test/broken',
					attributes: {},
					innerBlocks: [],
				} )
			).toBeNull();
		} );
	} );
} );
