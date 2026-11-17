/**
 * Internal dependencies
 */
import type {
	EngineBlock,
	EngineDocument,
} from '../engines/intent-log/engine-types';
import type { EditorBlock } from './gutenberg-contract';
import type { BlockIdentityTable } from './identity';

/*
 * Load: telling which editor block is which document block when a post
 * opens.
 *
 * The editor parses the saved post into blocks and gives each a clientId.
 * The room has its own document with lasting ids. Before the first local
 * edit can be captured, the two have to be matched.
 *
 * Call this once, after the first burst of the room's rows has been
 * applied, not on the first message. The first message holds only the
 * room's first document, and the room's history arrives right behind it.
 */

/** How the editor's blocks were matched. */
export interface LoadMatch {
	/** Blocks matched by the lasting id saved in the block. */
	bySavedId: number;
	/** Blocks matched by their place among their siblings. */
	byPosition: number;
	/** Editor blocks with no counterpart in the document. */
	unmatched: number;
}

/**
 * The lasting id an editor block carries in its attributes, if any.
 *
 * @param block The editor block.
 * @return The saved id.
 */
function savedSyncId( block: EditorBlock ): string | undefined {
	const { metadata } = block.attributes;

	if ( ! metadata || 'object' !== typeof metadata ) {
		return undefined;
	}

	const syncId = 'syncId' in metadata ? metadata.syncId : undefined;

	if ( 'string' === typeof syncId && '' !== syncId ) {
		return syncId;
	}

	return undefined;
}

/**
 * Links the editor's blocks to the document's blocks.
 *
 * A block that carries a saved id (`metadata.syncId`) is linked to the
 * document block with that id, wherever it is. The engine writes that id
 * into every block, so it is there whenever the post was saved after
 * someone edited it together.
 *
 * A block without a saved id is linked by its place: the same position
 * among the children of the same parent, and the same block type. That
 * covers a post nobody has edited together yet, where the room's first
 * document was built from the same saved content.
 *
 * A block that matches neither way is left alone. It is not in the
 * document, so the next block list from the engine will not hold it.
 *
 * @param ids    The id table. Links are added to it.
 * @param blocks The editor's blocks, as core-data passed them to `load`.
 * @param doc    The engine's document.
 * @return How many blocks were matched each way.
 */
export function linkLoadedBlocks(
	ids: BlockIdentityTable,
	blocks: EditorBlock[],
	doc: EngineDocument
): LoadMatch {
	const match: LoadMatch = { bySavedId: 0, byPosition: 0, unmatched: 0 };
	const documentBlocks = new Map< string, EngineBlock >();
	const indexDocument = ( siblings: EngineBlock[] ) => {
		for ( const block of siblings ) {
			documentBlocks.set( block.syncId, block );
			indexDocument( block.children );
		}
	};

	indexDocument( doc.root );

	// First every saved id, so that a block linked by place can never
	// take a document block that another editor block names outright.
	const linked = new Set< string >();
	const linkBySavedId = ( siblings: EditorBlock[] ) => {
		for ( const block of siblings ) {
			const syncId = savedSyncId( block );

			if (
				undefined !== syncId &&
				documentBlocks.has( syncId ) &&
				! linked.has( syncId )
			) {
				ids.link( block.clientId, syncId );
				linked.add( syncId );
				match.bySavedId++;
			}

			linkBySavedId( block.innerBlocks );
		}
	};

	linkBySavedId( blocks );

	const linkByPosition = (
		siblings: EditorBlock[],
		documentSiblings: EngineBlock[]
	) => {
		siblings.forEach( ( block, index ) => {
			let syncId = ids.getSyncId( block.clientId );

			if ( undefined === syncId || ! linked.has( syncId ) ) {
				const candidate = documentSiblings[ index ];

				if (
					candidate &&
					candidate.blockType === block.name &&
					! linked.has( candidate.syncId )
				) {
					ids.link( block.clientId, candidate.syncId );
					linked.add( candidate.syncId );
					match.byPosition++;
					syncId = candidate.syncId;
				} else {
					match.unmatched++;
					syncId = undefined;
				}
			}

			// The children of a block with no counterpart have none
			// either.
			const counterpart =
				undefined === syncId ? undefined : documentBlocks.get( syncId );

			linkByPosition( block.innerBlocks, counterpart?.children ?? [] );
		} );
	};

	linkByPosition( blocks, doc.root );

	return match;
}
