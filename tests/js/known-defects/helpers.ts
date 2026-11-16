/**
 * Internal dependencies
 */
import {
	blockToEngineSpec,
	deriveIntents,
	type BridgeBlock,
	type DerivedIntents,
} from '../../../src/engines/intent-log-bridge';
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';
import { createIntent } from '../../../src/engines/intent-log/intents.js';
import type {
	EngineDocument,
	IntentEnvelope,
} from '../../../src/engines/intent-log/engine-types';

/*
 * Shared helpers for the known-defect tests. Each test in this folder
 * states the correct behavior and is marked with it.failing, so it passes
 * today only because the defect is still there. When a change fixes a
 * defect, change its it.failing to it.
 */

/** One captured edit, as the bridge returns it. */
export type CapturedEdit = DerivedIntents[ 'intents' ][ number ];

/**
 * A paragraph block as the editor hands it over.
 *
 * @param syncId  The block's lasting id.
 * @param content The paragraph text.
 * @return The block.
 */
export function paragraph( syncId: string, content: string ): BridgeBlock {
	return {
		name: 'core/paragraph',
		attributes: { content, metadata: { syncId } },
		innerBlocks: [],
	};
}

/**
 * Builds the shared document for a list of editor blocks.
 *
 * @param blocks Editor blocks.
 * @return The document.
 */
export function documentFromBlocks( blocks: BridgeBlock[] ): EngineDocument {
	return createDocument(
		blocks.map( ( block ) => blockToEngineSpec( block ) )
	);
}

/**
 * Captures the edits that turn a document into an editor tree, the way
 * the engine does on every editor change.
 *
 * @param doc    The document the editor started from.
 * @param blocks The editor's new block tree.
 * @return The captured edits, in order.
 */
export function captureEdits(
	doc: EngineDocument,
	blocks: BridgeBlock[]
): CapturedEdit[] {
	const derived = deriveIntents( doc, blocks );
	if ( ! derived ) {
		throw new Error( 'The editor tree equals the document.' );
	}

	return derived.intents;
}

/**
 * Turns captured edits into the rows one person sends, all made against
 * the same position in the room's history.
 *
 * @param edits   Captured edits.
 * @param actorId The person sending them.
 * @param baseSeq The history position the edits were made against.
 * @return The rows.
 */
export function editsFrom(
	edits: CapturedEdit[],
	actorId: string,
	baseSeq = 0
): IntentEnvelope[] {
	return edits.map( ( edit, index ) =>
		createIntent( edit.type, edit.payload, {
			actorId,
			baseSeq,
			intentId: `${ actorId }#${ baseSeq }#${ index }`,
		} )
	);
}

/**
 * The text of a block's content field.
 *
 * @param doc    The document.
 * @param syncId The block's lasting id.
 * @return The text.
 */
export function contentText( doc: EngineDocument, syncId: string ): string {
	const block = getBlock( doc, syncId );
	if ( ! block ) {
		throw new Error( `Block ${ syncId } is not in the document.` );
	}

	return block.fields.content.text;
}

/**
 * The ids of the top-level blocks, in document order.
 *
 * @param doc The document.
 * @return The ids.
 */
export function blockOrder( doc: EngineDocument ): string[] {
	return doc.root.map( ( block ) => block.syncId );
}
