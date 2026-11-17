/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided by the editor runtime.
import {
	getBlockContent,
	getBlockType,
	getSaveContent,
	type Block,
} from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import type {
	BridgeBlock,
	RawContentAdapter,
	RichTextFieldsResolver,
	SaveMarkupAdapter,
} from '../engines/intent-log-bridge';

/*
 * What the engine needs to know about block types, read from the block
 * type definitions the editor has registered.
 *
 * The engine keeps a block's text attributes as text it can merge by
 * character, and everything else as plain values. So it has to know which
 * attributes are text, which blocks keep raw markup, what a block's saved
 * markup looks like, and which values are a block type's defaults.
 */

/**
 * A block in the shape the editor's serializer reads.
 *
 * @param block        The engine's form of an editor block.
 * @param fillDefaults Whether to add the block type's default attribute
 *                     values that are missing.
 * @return The block.
 */
export function toEditorBlock(
	block: BridgeBlock,
	fillDefaults = false
): Block {
	const editorBlock: Block = {
		clientId: block.clientId ?? '',
		isValid: true,
		name: block.name,
		attributes: fillDefaults
			? withAttributeDefaults( block.name, block.attributes )
			: block.attributes,
		innerBlocks: block.innerBlocks.map( ( child ) =>
			toEditorBlock( child, fillDefaults )
		),
	};

	if ( block.innerContent ) {
		editorBlock.innerContent = block.innerContent;
	}

	return editorBlock;
}

/**
 * The text attributes of a block type: the ones the editor reads from the
 * block's markup as rich text. They become the engine's text fields.
 *
 * @param blockName The block type.
 * @return The attribute names. A block type that is not registered is
 *         taken to have one, `content`.
 */
export const richTextFields: RichTextFieldsResolver = ( blockName ) => {
	const blockType = getBlockType( blockName );

	if ( ! blockType ) {
		return [ 'content' ];
	}

	return Object.entries( blockType.attributes ?? {} )
		.filter(
			( [ , schema ] ) =>
				'html' === schema?.source || 'rich-text' === schema?.source
		)
		.map( ( [ name ] ) => name );
};

/**
 * Blocks whose content is raw markup, kept outside any attribute the
 * engine could merge: Custom HTML and Classic. The engine keeps the whole
 * markup of such a block as one text.
 */
export const rawContent: RawContentAdapter = {
	is: ( blockName ) =>
		'core/html' === blockName || 'core/freeform' === blockName,

	/*
	 * The block's whole inner markup: its markup pieces, with the blocks
	 * inside it written out in place. A block made the older way holds
	 * its markup in a `content` attribute.
	 */
	serialize: ( block ) => {
		if ( block.innerContent ) {
			return getBlockContent( toEditorBlock( block ) );
		}

		const { content } = block.attributes;

		if ( 'string' === typeof content ) {
			return content;
		}

		return '';
	},

	/*
	 * Where the markup goes when the engine builds the editor's block:
	 * Custom HTML keeps it as markup pieces, Classic in its `content`
	 * attribute.
	 */
	hydrate: ( blockName, html ) => {
		if ( 'core/freeform' === blockName ) {
			return { attributes: { content: html } };
		}

		if ( '' === html ) {
			return { innerContent: [] };
		}

		return { innerContent: [ html ] };
	},
};

/**
 * The default attribute values of a block type.
 *
 * @param blockName The block type.
 * @return The defaults, by attribute name. Empty for a block type that is
 *         not registered.
 */
export function attributeDefaults(
	blockName: string
): Record< string, unknown > {
	const defaults: Record< string, unknown > = {};
	const blockType = getBlockType( blockName );

	for ( const [ name, schema ] of Object.entries(
		blockType?.attributes ?? {}
	) ) {
		if ( undefined !== schema?.default ) {
			defaults[ name ] = schema.default;
		}
	}

	return defaults;
}

/**
 * Adds a block type's default values to attributes that leave them out.
 *
 * The engine's document holds what the block comment in saved content
 * holds, and that leaves out default values. Some blocks cannot render
 * without them: a group reads its tag name from `tagName`, and with the
 * value missing it is saved as an empty comment.
 *
 * @param blockName  The block type.
 * @param attributes The attributes.
 * @return The attributes with the missing defaults added.
 */
export function withAttributeDefaults(
	blockName: string,
	attributes: Record< string, unknown >
): Record< string, unknown > {
	return { ...attributeDefaults( blockName ), ...attributes };
}

/**
 * Renders a block's saved markup with nothing inside it: the wrapper
 * element and the block's own markup.
 *
 * @param block The block. Default attribute values can be missing.
 * @return The markup, or null when the block type is not registered or
 *         cannot render the block.
 */
export const saveMarkup: SaveMarkupAdapter = ( block: BridgeBlock ) => {
	try {
		const blockType = getBlockType( block.name );

		if ( ! blockType ) {
			return null;
		}

		return getSaveContent(
			blockType,
			withAttributeDefaults( block.name, block.attributes ),
			[]
		);
	} catch {
		return null;
	}
};
