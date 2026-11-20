/**
 * Internal dependencies
 */
import { getBlock } from '../engines/intent-log/document.js';
import type {
	EngineBlock,
	EngineDocument,
} from '../engines/intent-log/engine-types';
import {
	engineBlockToBlock,
	type RawContentAdapter,
	type RichTextFieldsResolver,
} from '../engines/intent-log-bridge';
import type {
	EditorBlock,
	EditorSelection,
	SelectionEnd,
} from './gutenberg-contract';
import type { BlockIdentityTable } from './identity';
import { findTextChange } from './text-change';

/*
 * Apply: the engine's document in, editor blocks out.
 *
 * The engine's document is the truth. When it changes for a reason the
 * editor does not know about (someone else's edit, a correction to a local
 * edit), the editor is brought to it by handing core-data a new block
 * list. This module builds that list, and moves the person's caret along
 * with the text around it.
 *
 * Two things keep the editor calm when a list arrives:
 *
 * - Every block keeps the clientId the editor already knows it by, from
 *   the id table. A block the person is typing in stays mounted.
 * - A block that did not change is handed over as the very same object as
 *   last time, so the editor can see at a glance that it has nothing to
 *   do for it.
 */

/**
 * What building editor blocks needs.
 */
export interface EditorBlockBuilderOptions {
	/**
	 * The id table. A document block the editor does not hold yet gets a
	 * new clientId, and the link is added.
	 */
	ids: BlockIdentityTable;

	/** The text attributes of a block type. */
	richTextFields: RichTextFieldsResolver;

	/** How blocks whose content is raw markup are written. */
	rawContent?: RawContentAdapter;

	/**
	 * Adds a block type's default values to attributes that leave them
	 * out. Some blocks cannot be saved without them.
	 */
	withAttributeDefaults?: (
		blockName: string,
		attributes: Record< string, unknown >
	) => Record< string, unknown >;

	/** Makes a new clientId. Tests pass a predictable one. */
	mintClientId?: () => string;
}

/**
 * Builds the editor's block list from the engine's document.
 */
export interface EditorBlockBuilder {
	/**
	 * The editor blocks for a document. Blocks that did not change since
	 * the last call are the same objects as last time.
	 */
	build: ( doc: EngineDocument ) => EditorBlock[];

	/**
	 * Forgets the ids of blocks that the document of the last `build`
	 * call does not hold. Call it once the editor shows that document:
	 * from then on the editor cannot name such a block.
	 */
	forgetBlocksThatLeft: () => void;

	/** Forgets the blocks of earlier calls. */
	reset: () => void;
}

/** A block as it was built last time. */
interface BuiltBlock {
	/** The document block's own content, as text, without its children. */
	signature: string;
	block: EditorBlock;
}

/**
 * Creates a builder of editor blocks.
 *
 * @param options The id table and the block type helpers.
 * @return The builder.
 */
export function createEditorBlockBuilder(
	options: EditorBlockBuilderOptions
): EditorBlockBuilder {
	const { ids, richTextFields, rawContent } = options;
	const mintClientId =
		options.mintClientId ?? ( () => globalThis.crypto.randomUUID() );
	let built = new Map< string, BuiltBlock >();

	const buildBlock = (
		block: EngineBlock,
		next: Map< string, BuiltBlock >
	): EditorBlock => {
		const innerBlocks = block.children.map( ( child ) =>
			buildBlock( child, next )
		);
		let clientId = ids.getClientId( block.syncId );

		if ( undefined === clientId ) {
			clientId = mintClientId();
			ids.link( clientId, block.syncId );
		}

		// Everything about the block but its children. Two blocks with
		// the same text here give the same editor block.
		const signature = JSON.stringify( [
			clientId,
			block.blockType,
			block.attrs,
			block.fields,
		] );
		const previous = built.get( block.syncId );

		if ( previous && previous.signature === signature ) {
			const sameChildren =
				previous.block.innerBlocks.length === innerBlocks.length &&
				previous.block.innerBlocks.every(
					( child, index ) => child === innerBlocks[ index ]
				);
			// Unchanged: the same object. Only the children changed: a new
			// object that shares the attributes, so the block itself has
			// nothing to render again.
			const editorBlock = sameChildren
				? previous.block
				: { ...previous.block, innerBlocks };

			next.set( block.syncId, { signature, block: editorBlock } );

			return editorBlock;
		}

		const bridge = engineBlockToBlock(
			{ ...block, children: [] },
			richTextFields,
			rawContent
		);
		let attributes = bridge.attributes;

		if ( options.withAttributeDefaults ) {
			attributes = options.withAttributeDefaults(
				bridge.name,
				attributes
			);
		}

		const editorBlock: EditorBlock = {
			clientId,
			name: bridge.name,
			// A block built from the document is valid by definition. The
			// editor would otherwise show its "invalid content" notice.
			isValid: true,
			attributes,
			innerBlocks,
		};

		if ( bridge.innerContent ) {
			editorBlock.innerContent = bridge.innerContent;
		}

		next.set( block.syncId, { signature, block: editorBlock } );

		return editorBlock;
	};

	return {
		build: ( doc ) => {
			const next = new Map< string, BuiltBlock >();
			const blocks = doc.root.map( ( block ) =>
				buildBlock( block, next )
			);

			// Blocks that left the document are dropped with the old map.
			built = next;

			return blocks;
		},

		forgetBlocksThatLeft: () => {
			ids.keepOnly( new Set( built.keys() ) );
		},

		reset: () => {
			built = new Map();
		},
	};
}

/**
 * Moves one end of the selection along with the text around it.
 *
 * @param end    The selection end.
 * @param before The document the editor showed.
 * @param after  The document it is about to show.
 * @param ids    The id table.
 * @return The selection end for the new document.
 */
function moveSelectionEnd(
	end: SelectionEnd | undefined,
	before: EngineDocument,
	after: EngineDocument,
	ids: BlockIdentityTable
): SelectionEnd | undefined {
	if (
		! end ||
		undefined === end.clientId ||
		undefined === end.attributeKey ||
		'number' !== typeof end.offset
	) {
		return end;
	}

	const syncId = ids.getSyncId( end.clientId );

	if ( undefined === syncId ) {
		return end;
	}

	const oldText = getBlock( before, syncId )?.fields[ end.attributeKey ]
		?.text;
	const newText = getBlock( after, syncId )?.fields[ end.attributeKey ]?.text;

	if ( undefined === oldText || undefined === newText ) {
		return end;
	}

	const { change } = findTextChange( oldText, newText );

	if ( ! change || end.offset <= change.start ) {
		// The text changed after the caret, or not at all.
		return end;
	}

	const removedEnd = change.start + change.removed.length;

	if ( end.offset >= removedEnd ) {
		// The text changed before the caret: the caret keeps its place
		// among the letters after the change.
		return {
			...end,
			offset: end.offset + change.inserted.length - change.removed.length,
		};
	}

	// The caret was inside text that is gone. It goes to the end of what
	// replaced it.
	return { ...end, offset: change.start + change.inserted.length };
}

/**
 * Moves the person's selection along when the document changes under
 * it. Text that someone else puts in front of the caret pushes the caret
 * forward by the same amount, so it stays between the same two letters.
 *
 *   before "Hello| world", someone adds "Oh, " at the start
 *   after  "Oh, Hello| world": the caret moved from 5 to 9
 *
 * A selection outside a text, or in a block that is gone, is returned as
 * it is.
 *
 * @param selection The editor's selection.
 * @param before    The document the editor showed.
 * @param after     The document it is about to show.
 * @param ids       The id table.
 * @return The selection to hand to the editor with the new blocks, or
 *         undefined when there was none.
 */
export function moveSelection(
	selection: EditorSelection | undefined,
	before: EngineDocument,
	after: EngineDocument,
	ids: BlockIdentityTable
): EditorSelection | undefined {
	if ( ! selection ) {
		return undefined;
	}

	const selectionStart = moveSelectionEnd(
		selection.selectionStart,
		before,
		after,
		ids
	);
	const selectionEnd = moveSelectionEnd(
		selection.selectionEnd,
		before,
		after,
		ids
	);

	if (
		selectionStart === selection.selectionStart &&
		selectionEnd === selection.selectionEnd
	) {
		return selection;
	}

	return { ...selection, selectionStart, selectionEnd };
}
