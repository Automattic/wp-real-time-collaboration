/**
 * Internal dependencies
 */
import { getBlock } from '../engines/intent-log/document.js';
import { applyIntent } from '../engines/intent-log/reducer.js';
import { htmlToField } from '../engines/intent-log/rich-text.js';
import { mintSyncId } from '../engines/intent-log/sync-id.js';
import type {
	EngineBlock,
	EngineDocument,
	EngineField,
} from '../engines/intent-log/engine-types';
import {
	blockToEngineSpec,
	diffFormats,
	engineBlockToBlock,
	serializeAttribute,
	type BridgeBlock,
	type RawContentAdapter,
	type RichTextFieldsResolver,
	type SaveMarkupAdapter,
} from '../engines/intent-log-bridge';
import type {
	BlockOperation,
	EditorBlock,
	EditorSelection,
	SelectionEnd,
} from './gutenberg-contract';
import type { BlockIdentityTable } from './identity';
import { longestRisingRun } from './rising-run';
import { findTextChange, type CaretHint, type TextChange } from './text-change';

/*
 * Capture: the editor's block operations in, engine edits out.
 *
 * core-data hands over every local edit as a batch of operations: this
 * block was inserted here, this one moved, this attribute changed from one
 * value to another. One batch is one action of the person editing. This
 * module turns a batch into the engine's edits (intents).
 *
 * Nothing here compares block trees or guesses which block is which. The
 * id table says which document block an editor block is, and the batch
 * says what changed.
 *
 * What a batch becomes:
 *
 *   insert                     insert_block, at the block's final place
 *   remove                     remove_block
 *   move                       move_block, for the block that moved
 *   set-attribute, plain       set_attr, or remove_attr when cleared
 *   set-attribute, text        insert_text, delete_text, replace_text,
 *                              format_text
 *   set-block-property "name"  transform_block
 *
 * Four shapes are recognised across the operations of one batch, so that
 * other people's edits stay attached to the right block:
 *
 * - A split. One block's text gets shorter and a new block with the rest
 *   of the text appears right after it. This becomes split_block.
 * - A merge. One block's text grows by exactly the text of the next
 *   block, and that block is removed. This becomes merge_blocks.
 * - A change of block type. One block is removed and one block of another
 *   type is inserted in the same place, with the same children. The
 *   document block keeps its id and gets transform_block.
 * - The same block again. A block is removed and inserted again in one
 *   batch, under the same clientId or carrying the same saved id (indent a
 *   list item, group blocks). The document block keeps its id and moves.
 *
 * When a shape does not match exactly, the plain edits are emitted. The
 * result is still correct.
 *
 * The final order decides the moves. Gutenberg can report "new block at
 * the end, then move the blocks that follow it". Read as it stands, that
 * tells everyone the following blocks moved, which they did not. So
 * capture works out where every block ends up, and emits a move only for
 * a block whose place among the blocks that stayed really changed.
 */

/** One engine edit, before the session stamps it. */
export interface CapturedIntent {
	type: string;
	payload: Record< string, unknown >;
}

/**
 * Counts of things that should be rare. A number that grows says the
 * editor and the engine disagree in a way nobody planned for.
 */
export interface CaptureCounters {
	/**
	 * A `previousValue` did not equal the engine's value: the editor was
	 * showing an older document when the person made the edit.
	 */
	stalePreviousValue: number;
	/**
	 * The caret did not explain a text change, so the start and the end of
	 * the two texts were compared.
	 */
	caretFallback: number;
	/** An operation named a block the engine does not know. */
	unknownClientId: number;
	/** An edit that the document refused, and that was left out. */
	droppedIntents: number;
}

/**
 * What capture needs besides the document and the operations.
 */
export interface CaptureContext {
	/**
	 * The id table. Capture adds a link for every block it gives an id
	 * to, and drops the links of removed blocks.
	 */
	ids: BlockIdentityTable;

	/** The text attributes of a block type. They become engine fields. */
	richTextFields: RichTextFieldsResolver;

	/** How blocks whose content is raw markup are read. */
	rawContent?: RawContentAdapter;

	/**
	 * Renders a block's saved markup. Called only for blocks an operation
	 * touched. The block passed in can come from the document, which
	 * leaves out default attribute values, so the function must fill
	 * those in itself.
	 */
	saveMarkup?: SaveMarkupAdapter;

	/**
	 * The default attribute values of a block type. A whole block that
	 * arrives for a block the document already holds is compared with the
	 * document, and a default value the document leaves out is not an
	 * edit.
	 */
	attributeDefaults?: ( blockName: string ) => Record< string, unknown >;

	/** The editor's selection after this batch. */
	selection?: EditorSelection;

	/** The selection of the batch before this one. */
	previousSelection?: EditorSelection;

	/**
	 * Reads the saved id (`metadata.syncId`) of an editor block the table
	 * does not know. The editor gives every block a new clientId when it
	 * parses the content again, and tells nobody.
	 */
	lookupSavedSyncId?: ( clientId: string ) => string | undefined;

	/** Makes a new lasting id. Tests pass a predictable one. */
	mintId?: () => string;
}

/**
 * What one batch turned into.
 */
export interface CaptureResult {
	/** The edits, in the order they apply. */
	intents: CapturedIntent[];
	/** The document after the edits. */
	doc: EngineDocument;
	counters: CaptureCounters;
	/**
	 * True when an editor block does not carry the id the document knows
	 * it by: a new block, the second half of a split, a block that changed
	 * type. The id still has to be written into the block's
	 * `metadata.syncId`, in a later task.
	 */
	identityNeedsWrite: boolean;
	/**
	 * Raw markup blocks whose markup changed in a way the operations do
	 * not spell out: a block inside one was added, removed or edited. The
	 * document keeps such a block's whole markup as one text, so the
	 * caller has to read the block from the editor in a later task and
	 * send its markup.
	 */
	rawContentToRefresh: string[];
}

/** A block that arrived whole with an insert operation. */
interface PendingBlock {
	clientId: string;
	name: string;
	attributes: Record< string, unknown >;
	innerContent?: Array< string | null >;
	/**
	 * The blocks inside a raw markup block. The document keeps them as
	 * part of that block's markup, not as blocks of their own.
	 */
	rawInnerBlocks?: EditorBlock[];
}

/** A change to one block the document already holds. */
type BlockChange =
	| {
			kind: 'attribute';
			syncId: string;
			clientId: string;
			attribute: string;
			previousValue: unknown;
			value: unknown;
	  }
	| { kind: 'name'; syncId: string; value: string }
	| { kind: 'innerContent'; syncId: string; value: string };

/** Which blocks are inside which, by document id. Null is the top level. */
interface Structure {
	children: Map< string | null, string[] >;
	parents: Map< string, string | null >;
}

const EMPTY_FIELD: EngineField = { text: '', formats: [] };

/**
 * Whether a value is a plain object.
 *
 * @param value Any value.
 * @return Whether it is an object that is not an array.
 */
function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && 'object' === typeof value && ! Array.isArray( value );
}

/**
 * Whether two JSON values are equal.
 *
 * @param a One value.
 * @param b The other value.
 * @return Whether they are written the same way as JSON.
 */
function sameValue( a: unknown, b: unknown ): boolean {
	return JSON.stringify( a ) === JSON.stringify( b );
}

/**
 * The lasting id a block carries in its attributes, if any.
 *
 * @param attributes The block's attributes.
 * @return The saved id.
 */
function savedSyncId(
	attributes: Record< string, unknown >
): string | undefined {
	const { metadata } = attributes;

	if ( ! isRecord( metadata ) ) {
		return undefined;
	}

	const { syncId } = metadata;

	if ( 'string' === typeof syncId && '' !== syncId ) {
		return syncId;
	}

	return undefined;
}

/**
 * A `metadata` attribute value without the lasting id. The id is the
 * engine's own bookkeeping, not an attribute of the document block.
 *
 * @param value The attribute value.
 * @return The value without `syncId`, or undefined when nothing is left.
 */
function withoutSyncId( value: unknown ): unknown {
	if ( ! isRecord( value ) ) {
		return value;
	}

	const rest: Record< string, unknown > = {};

	for ( const [ key, entry ] of Object.entries( value ) ) {
		if ( 'syncId' !== key ) {
			rest[ key ] = entry;
		}
	}

	if ( 0 === Object.keys( rest ).length ) {
		return undefined;
	}

	return rest;
}

/**
 * An editor block in the shape the bridge reads, with everything inside
 * it.
 *
 * @param block The editor block.
 * @return The block.
 */
function toBridgeBlock( block: EditorBlock ): BridgeBlock {
	const bridge: BridgeBlock = {
		name: block.name,
		attributes: block.attributes,
		innerBlocks: block.innerBlocks.map( toBridgeBlock ),
	};

	if ( block.innerContent ) {
		bridge.innerContent = block.innerContent;
	}

	return bridge;
}

/**
 * An attribute value as an engine text field.
 *
 * @param value A rich text object, a string of HTML, or nothing.
 * @return The field.
 */
function fieldOf( value: unknown ): EngineField {
	const html = serializeAttribute( value );

	if ( 'string' === typeof html ) {
		return htmlToField( html );
	}

	return htmlToField( '' );
}

/**
 * Reads which blocks are inside which.
 *
 * @param doc The document.
 * @return The structure.
 */
function readStructure( doc: EngineDocument ): Structure {
	const structure: Structure = {
		children: new Map(),
		parents: new Map(),
	};
	const walk = ( blocks: EngineBlock[], parentId: string | null ) => {
		structure.children.set(
			parentId,
			blocks.map( ( block ) => block.syncId )
		);

		for ( const block of blocks ) {
			structure.parents.set( block.syncId, parentId );
			walk( block.children, block.syncId );
		}
	};

	walk( doc.root, null );

	return structure;
}

/**
 * The ids of every block that can be reached from the top level.
 *
 * @param structure The structure.
 * @return The ids.
 */
function reachableIds( structure: Structure ): Set< string > {
	const reachable = new Set< string >();
	const walk = ( parentId: string | null ) => {
		for ( const id of structure.children.get( parentId ) ?? [] ) {
			if ( ! reachable.has( id ) ) {
				reachable.add( id );
				walk( id );
			}
		}
	};

	walk( null );

	return reachable;
}

/**
 * The ids of a document block's children, or of the top level.
 *
 * @param doc      The document.
 * @param parentId The parent's id, or null for the top level.
 * @return The ids, or undefined when the parent is not in the document.
 */
function childIdsIn(
	doc: EngineDocument,
	parentId: string | null
): string[] | undefined {
	if ( null === parentId ) {
		return doc.root.map( ( block ) => block.syncId );
	}

	return getBlock( doc, parentId )?.children.map( ( block ) => block.syncId );
}

/**
 * Picks the blocks of one parent that do not have to move.
 *
 * A block the batch did not relocate never moves: the operations name the
 * blocks that moved, and everything else keeps its order. A block the
 * batch did relocate stays put too when its old place still fits between
 * the blocks that did not move. Gutenberg sometimes reports "moved to the
 * end" for a block that is where it was.
 *
 * @param staying   The blocks that are in the parent before and after, in
 *                  their final order.
 * @param positions Where each block is in the parent now.
 * @param relocated The blocks an operation of the batch placed.
 * @return The blocks that do not move.
 */
function pickUnmoved(
	staying: string[],
	positions: Map< string, number >,
	relocated: Set< string >
): Set< string > {
	const values = staying.map( ( id ) => positions.get( id ) ?? 0 );
	const isFixed = staying.map( ( id ) => ! relocated.has( id ) );
	const fixedValues = values.filter( ( _value, index ) => isFixed[ index ] );
	const fixedInOrder = fixedValues.every(
		( value, index ) => 0 === index || fixedValues[ index - 1 ] < value
	);

	if ( ! fixedInOrder ) {
		// Not expected. Fall back to the largest group that keeps its
		// order, whichever blocks that is.
		const run = longestRisingRun( values );

		return new Set( staying.filter( ( _id, index ) => run.has( index ) ) );
	}

	const unmoved = new Set< string >();
	let between: number[] = [];
	let low = -1;

	// Between two blocks that stay, keep the relocated blocks whose old
	// places lie between those two, as many as keep their order.
	for ( let index = 0; index <= staying.length; index++ ) {
		if ( index < staying.length && ! isFixed[ index ] ) {
			between.push( index );
			continue;
		}

		const high = index < staying.length ? values[ index ] : Infinity;
		const fitting = between.filter(
			( candidate ) =>
				values[ candidate ] > low && values[ candidate ] < high
		);
		const run = longestRisingRun(
			fitting.map( ( candidate ) => values[ candidate ] )
		);

		fitting.forEach( ( candidate, position ) => {
			if ( run.has( position ) ) {
				unmoved.add( staying[ candidate ] );
			}
		} );

		if ( index < staying.length ) {
			unmoved.add( staying[ index ] );
			low = values[ index ];
		}

		between = [];
	}

	return unmoved;
}

/**
 * Where a selection end is, when it is a caret inside one text attribute.
 *
 * @param end       The selection end.
 * @param clientId  The block.
 * @param attribute The attribute.
 * @return The offset, or undefined.
 */
function offsetIn(
	end: SelectionEnd | undefined,
	clientId: string,
	attribute: string
): number | undefined {
	if (
		end &&
		end.clientId === clientId &&
		end.attributeKey === attribute &&
		'number' === typeof end.offset
	) {
		return end.offset;
	}

	return undefined;
}

/**
 * What the selections around a batch say about a text edit.
 *
 * @param selection         The selection after the batch.
 * @param previousSelection The selection of the batch before.
 * @param clientId          The edited block.
 * @param attribute         The edited attribute.
 * @return The hint for finding the change.
 */
function caretHint(
	selection: EditorSelection | undefined,
	previousSelection: EditorSelection | undefined,
	clientId: string,
	attribute: string
): CaretHint {
	const hint: CaretHint = {};
	const afterStart = offsetIn(
		selection?.selectionStart,
		clientId,
		attribute
	);
	const afterEnd = offsetIn( selection?.selectionEnd, clientId, attribute );

	if ( undefined !== afterStart && afterStart === afterEnd ) {
		hint.after = afterStart;
	}

	const beforeStart = offsetIn(
		previousSelection?.selectionStart,
		clientId,
		attribute
	);
	const beforeEnd = offsetIn(
		previousSelection?.selectionEnd,
		clientId,
		attribute
	);

	if (
		undefined !== beforeStart &&
		undefined !== beforeEnd &&
		beforeStart !== beforeEnd
	) {
		hint.before = {
			start: Math.min( beforeStart, beforeEnd ),
			end: Math.max( beforeStart, beforeEnd ),
		};
	}

	return hint;
}

/**
 * Turns the block operations of one batch into engine edits.
 *
 * The operations must come from one batch, in order. The document is the
 * engine's own current document (with the person's unanswered edits), not
 * a copy of what the editor shows.
 *
 * @param doc        The engine's document. Not changed.
 * @param operations The batch's block operations.
 * @param context    The id table and the block type helpers.
 * @return The edits, the document after them, and the counters.
 */
export function captureBlockOperations(
	doc: EngineDocument,
	operations: BlockOperation[],
	context: CaptureContext
): CaptureResult {
	const { ids, richTextFields, rawContent, saveMarkup } = context;
	const mint = context.mintId ?? ( () => mintSyncId() );
	const counters: CaptureCounters = {
		stalePreviousValue: 0,
		caretFallback: 0,
		unknownClientId: 0,
		droppedIntents: 0,
	};
	const intents: CapturedIntent[] = [];
	let working = doc;
	let identityNeedsWrite = false;

	/**
	 * Applies an edit to the working document and keeps it. An edit the
	 * document refuses is counted and left out.
	 *
	 * @param type    The edit type.
	 * @param payload The edit payload.
	 * @return Whether the edit was kept.
	 */
	const emit = (
		type: string,
		payload: Record< string, unknown >
	): boolean => {
		const result = applyIntent( working, {
			intentId: 'capture',
			actorId: 'capture',
			baseSeq: 0,
			txnId: null,
			type,
			payload,
		} );

		if ( 'applied' !== result.disposition.status ) {
			counters.droppedIntents++;

			return false;
		}

		working = result.doc;
		intents.push( { type, payload } );

		return true;
	};

	const fieldNames = ( blockType: string ): string[] => {
		if ( rawContent?.is( blockType ) ) {
			return [ 'content' ];
		}

		return richTextFields( blockType );
	};

	/*
	 * Blocks that arrived whole with an insert. `newBlocks` are new to the
	 * document. `replaced` are blocks the document already holds, under
	 * the id each is keyed by.
	 */
	const newBlocks = new Map< string, PendingBlock >();
	const replaced = new Map< string, PendingBlock >();
	let changes: BlockChange[] = [];
	// Editor ids whose block lives on under another editor id.
	const retiredClientIds = new Set< string >();
	// Document ids already given to an inserted block in this batch.
	const claimed = new Set< string >();
	// Document blocks an operation of this batch placed somewhere.
	const relocated = new Set< string >();
	// Raw markup blocks whose markup the caller has to read again.
	const rawContentToRefresh = new Set< string >();

	/**
	 * Handles an operation that places a block inside a raw markup block.
	 * The document does not keep such blocks as blocks of their own.
	 *
	 * @param parentId The parent's document id.
	 * @param inserted The block, when the operation is an insert.
	 * @return Whether the parent is a raw markup block.
	 */
	const placedInRawContent = (
		parentId: string,
		inserted?: EditorBlock
	): boolean => {
		const pending = newBlocks.get( parentId ) ?? replaced.get( parentId );
		const blockType = pending
			? pending.name
			: getBlock( doc, parentId )?.blockType;

		if ( undefined === blockType || ! rawContent?.is( blockType ) ) {
			return false;
		}

		if ( pending && inserted ) {
			pending.rawInnerBlocks = [
				...( pending.rawInnerBlocks ?? [] ),
				inserted,
			];
		} else {
			rawContentToRefresh.add( parentId );
		}

		return true;
	};

	const resolve = ( clientId: string ): string | undefined => {
		const known = ids.getSyncId( clientId );

		if ( undefined !== known ) {
			return known;
		}

		const saved = context.lookupSavedSyncId?.( clientId );

		if ( undefined !== saved && getBlock( doc, saved ) ) {
			ids.link( clientId, saved );

			return saved;
		}

		return undefined;
	};

	const hasStructuralOperation = operations.some(
		( operation ) =>
			'insert' === operation.type ||
			'remove' === operation.type ||
			'move' === operation.type
	);
	const original = hasStructuralOperation ? readStructure( doc ) : null;
	const final = hasStructuralOperation ? readStructure( doc ) : null;

	const detach = ( structure: Structure, syncId: string ) => {
		if ( ! structure.parents.has( syncId ) ) {
			return;
		}

		const parentId = structure.parents.get( syncId ) ?? null;
		const siblings = structure.children.get( parentId );
		const index = siblings ? siblings.indexOf( syncId ) : -1;

		if ( siblings && index >= 0 ) {
			siblings.splice( index, 1 );
		}

		structure.parents.delete( syncId );
	};

	const attach = (
		structure: Structure,
		syncId: string,
		parentId: string | null,
		beforeId: string | null
	) => {
		detach( structure, syncId );

		let siblings = structure.children.get( parentId );

		if ( ! siblings ) {
			siblings = [];
			structure.children.set( parentId, siblings );
		}

		const index = null === beforeId ? -1 : siblings.indexOf( beforeId );

		if ( index >= 0 ) {
			siblings.splice( index, 0, syncId );
		} else {
			siblings.push( syncId );
		}

		structure.parents.set( syncId, parentId );
	};

	/*
	 * The document blocks that a remove operation of this batch names,
	 * with everything inside them. An inserted block that carries the
	 * saved id of one of them is that block, under a new editor id.
	 */
	const removedByBatch = new Set< string >();

	for ( const operation of operations ) {
		if ( 'remove' !== operation.type ) {
			continue;
		}

		const syncId = ids.getSyncId( operation.clientId );
		const block = undefined === syncId ? null : getBlock( doc, syncId );
		const collect = ( blocks: EngineBlock[] ) => {
			for ( const child of blocks ) {
				removedByBatch.add( child.syncId );
				collect( child.children );
			}
		};

		if ( block ) {
			collect( [ block ] );
		}
	}

	/**
	 * Gives an inserted block, and every block inside it, its document
	 * id, and puts its children in place.
	 *
	 * @param structure The structure being built.
	 * @param block     The inserted block.
	 * @return The block's document id.
	 */
	const adopt = ( structure: Structure, block: EditorBlock ): string => {
		const known = ids.getSyncId( block.clientId );
		const saved = savedSyncId( block.attributes );
		let syncId: string;
		let isNew = true;

		if ( undefined !== known && newBlocks.has( known ) ) {
			syncId = known;
		} else if ( undefined !== known && getBlock( doc, known ) ) {
			// The same editor block again: it moved.
			syncId = known;
			isNew = false;
		} else if (
			undefined !== saved &&
			removedByBatch.has( saved ) &&
			! claimed.has( saved )
		) {
			// A copy of a block this batch removes: the same block under a
			// new editor id.
			const retired = ids.getClientId( saved );

			if ( undefined !== retired ) {
				retiredClientIds.add( retired );
			}

			syncId = saved;
			isNew = false;
		} else if (
			undefined !== saved &&
			! claimed.has( saved ) &&
			! getBlock( doc, saved )
		) {
			// The block brings an id the document does not hold.
			syncId = saved;
		} else {
			syncId = mint();
		}

		claimed.add( syncId );
		ids.link( block.clientId, syncId );

		if ( saved !== syncId ) {
			identityNeedsWrite = true;
		}

		const pending: PendingBlock = {
			clientId: block.clientId,
			name: block.name,
			attributes: { ...block.attributes },
		};

		if ( block.innerContent ) {
			pending.innerContent = block.innerContent;
		}

		if ( isNew ) {
			newBlocks.set( syncId, pending );
		} else {
			replaced.set( syncId, pending );
			// The whole block is the newer word on its attributes.
			changes = changes.filter( ( change ) => change.syncId !== syncId );
		}

		// The inserted block names its children. Anything else that was
		// inside it is gone unless a later operation places it.
		detach( structure, syncId );
		structure.children.set( syncId, [] );

		if ( rawContent?.is( block.name ) ) {
			// What is inside a raw markup block is part of its markup.
			pending.rawInnerBlocks = block.innerBlocks;

			return syncId;
		}

		for ( const child of block.innerBlocks ) {
			const childId = adopt( structure, child );

			attach( structure, childId, syncId, null );
			relocated.add( childId );
		}

		return syncId;
	};

	const forgetNewBlock = ( structure: Structure, syncId: string ) => {
		newBlocks.delete( syncId );

		for ( const childId of structure.children.get( syncId ) ?? [] ) {
			forgetNewBlock( structure, childId );
		}
	};

	/*
	 * First pass: read the operations in order. Structure changes go into
	 * `final`. Changes to blocks the document holds are kept for later.
	 */
	for ( const operation of operations ) {
		if ( 'insert' === operation.type ) {
			if ( ! final ) {
				continue;
			}

			let parentId: string | null = null;

			if ( null !== operation.parent ) {
				const resolvedParent = resolve( operation.parent );

				if ( undefined === resolvedParent ) {
					counters.unknownClientId++;
					continue;
				}

				parentId = resolvedParent;
			}

			if (
				null !== parentId &&
				placedInRawContent( parentId, operation.block )
			) {
				continue;
			}

			const beforeId =
				null === operation.before
					? null
					: resolve( operation.before ) ?? null;
			const syncId = adopt( final, operation.block );

			attach( final, syncId, parentId, beforeId );
			relocated.add( syncId );
			continue;
		}

		if ( 'remove' === operation.type ) {
			if ( ! final || retiredClientIds.has( operation.clientId ) ) {
				continue;
			}

			const syncId = resolve( operation.clientId );

			if ( undefined === syncId ) {
				counters.unknownClientId++;
				continue;
			}

			if ( newBlocks.has( syncId ) ) {
				forgetNewBlock( final, syncId );
			}

			detach( final, syncId );
			continue;
		}

		if ( 'move' === operation.type ) {
			if ( ! final ) {
				continue;
			}

			const syncId = resolve( operation.clientId );
			let parentId: string | null = null;

			if ( null !== operation.parent ) {
				const resolvedParent = resolve( operation.parent );

				if ( undefined === resolvedParent ) {
					counters.unknownClientId++;
					continue;
				}

				parentId = resolvedParent;
			}

			if ( null !== parentId && placedInRawContent( parentId ) ) {
				// The block leaves the document's blocks and becomes part
				// of the parent's markup.
				if ( undefined !== syncId ) {
					detach( final, syncId );
				}

				continue;
			}

			if ( undefined === syncId ) {
				counters.unknownClientId++;
				continue;
			}

			const beforeId =
				null === operation.before
					? null
					: resolve( operation.before ) ?? null;

			attach( final, syncId, parentId, beforeId );
			relocated.add( syncId );
			continue;
		}

		const syncId = resolve( operation.clientId );

		if ( undefined === syncId ) {
			counters.unknownClientId++;
			continue;
		}

		const pending = newBlocks.get( syncId ) ?? replaced.get( syncId );

		if ( 'set-attribute' === operation.type ) {
			if ( pending ) {
				if ( undefined === operation.value ) {
					delete pending.attributes[ operation.attribute ];
				} else {
					pending.attributes[ operation.attribute ] = operation.value;
				}

				continue;
			}

			changes.push( {
				kind: 'attribute',
				syncId,
				clientId: operation.clientId,
				attribute: operation.attribute,
				previousValue: operation.previousValue,
				value: operation.value,
			} );
			continue;
		}

		// A block property. Only the type and the raw markup pieces are
		// part of the document. The rest is the editor's own.
		if (
			'name' === operation.property &&
			'string' === typeof operation.value
		) {
			if ( pending ) {
				pending.name = operation.value;
			} else {
				changes.push( {
					kind: 'name',
					syncId,
					value: operation.value,
				} );
			}

			continue;
		}

		if (
			'innerContent' === operation.property &&
			Array.isArray( operation.value )
		) {
			// A piece that is not text marks the place of a block inside
			// the markup.
			const pieces = operation.value.map( ( piece ) => {
				if ( 'string' === typeof piece ) {
					return piece;
				}

				return null;
			} );

			if ( pending ) {
				pending.innerContent = pieces;
			} else if ( pieces.includes( null ) ) {
				rawContentToRefresh.add( syncId );
			} else {
				changes.push( {
					kind: 'innerContent',
					syncId,
					value: pieces.join( '' ),
				} );
			}
		}
	}

	/**
	 * The editor form of a pending block, carrying its document id.
	 *
	 * @param syncId          The block's document id.
	 * @param pending         The pending block.
	 * @param withNewChildren Whether to include the children that are new
	 *                        to the document too.
	 * @return The block.
	 */
	const bridgeBlockFor = (
		syncId: string,
		pending: PendingBlock,
		withNewChildren: boolean
	): BridgeBlock => {
		const metadata = isRecord( pending.attributes.metadata )
			? pending.attributes.metadata
			: {};
		const innerBlocks: BridgeBlock[] = ( pending.rawInnerBlocks ?? [] ).map(
			toBridgeBlock
		);

		if ( withNewChildren && final ) {
			for ( const childId of final.children.get( syncId ) ?? [] ) {
				const child = newBlocks.get( childId );

				if ( child ) {
					innerBlocks.push( bridgeBlockFor( childId, child, true ) );
				}
			}
		}

		const block: BridgeBlock = {
			name: pending.name,
			attributes: {
				...pending.attributes,
				metadata: { ...metadata, syncId },
			},
			innerBlocks,
		};

		if ( pending.innerContent ) {
			block.innerContent = pending.innerContent;
		}

		return block;
	};

	const emitTextChange = (
		syncId: string,
		field: string,
		change: TextChange
	) => {
		if ( '' === change.removed ) {
			emit( 'insert_text', {
				syncId,
				field,
				offset: change.start,
				text: change.inserted,
			} );
			return;
		}

		const range = {
			syncId,
			field,
			start: change.start,
			end: change.start + change.removed.length,
			removedText: change.removed,
		};

		if ( '' === change.inserted ) {
			emit( 'delete_text', range );
			return;
		}

		emit( 'replace_text', { ...range, text: change.inserted } );
	};

	/**
	 * Brings one text field of a document block to a new value.
	 *
	 * @param syncId   The block.
	 * @param name     The field.
	 * @param next     The new value.
	 * @param previous The value the editor held before, when it said so.
	 * @param hint     What the selection says about the edit.
	 */
	const captureField = (
		syncId: string,
		name: string,
		next: EngineField,
		previous: EngineField | undefined,
		hint: CaretHint
	) => {
		const current =
			getBlock( working, syncId )?.fields[ name ] ?? EMPTY_FIELD;
		// The text before this batch. An earlier edit of the same batch
		// (a split, a merge) may already have changed the working text.
		const atStart = getBlock( doc, syncId )?.fields[ name ] ?? EMPTY_FIELD;
		let change: TextChange | null;

		if (
			previous &&
			previous.text !== current.text &&
			previous.text !== atStart.text
		) {
			/*
			 * The editor showed an older text. Take the change the person
			 * made to that older text and place it on the engine's text.
			 * Only when it cannot be placed, bring the field to the
			 * editor's value as a whole.
			 */
			counters.stalePreviousValue++;
			change = findTextChange( previous.text, next.text, hint ).change;

			if (
				change &&
				current.text.slice(
					change.start,
					change.start + change.removed.length
				) !== change.removed
			) {
				change = findTextChange( current.text, next.text ).change;
			}
		} else {
			const result = findTextChange( current.text, next.text, hint );

			if ( result.caretFailed ) {
				counters.caretFallback++;
			}

			change = result.change;
		}

		if ( change ) {
			emitTextChange( syncId, name, change );
		}

		const after = getBlock( working, syncId )?.fields[ name ];

		if ( after ) {
			for ( const intent of diffFormats( after, next, syncId, name ) ) {
				emit( intent.type, intent.payload );
			}
		}
	};

	// The newest value of each changed text attribute, for the split and
	// merge shapes.
	const lastTextValues = new Map<
		string,
		{ syncId: string; attribute: string; value: unknown }
	>();
	const changeCounts = new Map< string, number >();

	for ( const change of changes ) {
		if ( 'attribute' !== change.kind ) {
			continue;
		}

		const key = `${ change.syncId }\n${ change.attribute }`;

		lastTextValues.set( key, change );
		changeCounts.set( key, ( changeCounts.get( key ) ?? 0 ) + 1 );
	}

	// The blocks this batch created, for the blocks that need no second
	// look at their saved markup.
	const created = new Set< string >();

	if ( original && final ) {
		/*
		 * A change of block type: one block removed, one block of another
		 * type inserted in its place, with the same children. The document
		 * block keeps its id.
		 */
		let reachable = reachableIds( final );
		const removedRoots: string[] = [];

		for ( const [ syncId, parentId ] of original.parents ) {
			if (
				! reachable.has( syncId ) &&
				( null === parentId || reachable.has( parentId ) )
			) {
				removedRoots.push( syncId );
			}
		}

		const newRoots = [ ...newBlocks.keys() ].filter( ( syncId ) => {
			const parentId = final.parents.get( syncId ) ?? null;

			return (
				reachable.has( syncId ) &&
				( null === parentId || ! newBlocks.has( parentId ) )
			);
		} );

		if ( 1 === removedRoots.length && 1 === newRoots.length ) {
			const [ removedId ] = removedRoots;
			const [ newId ] = newRoots;
			const pending = newBlocks.get( newId );
			const removedBlock = getBlock( doc, removedId );
			const parentId = original.parents.get( removedId ) ?? null;
			const before = original.children.get( parentId ) ?? [];
			const after = final.children.get( parentId ) ?? [];

			// The nearest earlier sibling that is in the parent both
			// before and after says whether the two are in the same place.
			const anchorBefore = before
				.slice( 0, before.indexOf( removedId ) )
				.reverse()
				.find( ( id ) => after.includes( id ) );
			const anchorAfter = after
				.slice( 0, Math.max( 0, after.indexOf( newId ) ) )
				.reverse()
				.find( ( id ) => before.includes( id ) );
			const oldChildren = original.children.get( removedId ) ?? [];
			const newChildren = final.children.get( newId ) ?? [];

			if (
				pending &&
				removedBlock &&
				pending.name !== removedBlock.blockType &&
				( final.parents.get( newId ) ?? null ) === parentId &&
				after.includes( newId ) &&
				anchorBefore === anchorAfter &&
				oldChildren.length === newChildren.length &&
				oldChildren.every( ( id ) => newChildren.includes( id ) )
			) {
				newBlocks.delete( newId );
				replaced.set( removedId, pending );
				relocated.add( removedId );
				ids.link( pending.clientId, removedId );
				identityNeedsWrite = true;

				after[ after.indexOf( newId ) ] = removedId;
				final.parents.delete( newId );
				final.parents.set( removedId, parentId );
				final.children.delete( newId );
				final.children.set( removedId, newChildren );

				for ( const childId of newChildren ) {
					final.parents.set( childId, removedId );
				}

				reachable = reachableIds( final );
			}
		}

		for ( const { syncId, attribute, value } of lastTextValues.values() ) {
			const block = getBlock( working, syncId );

			if (
				! block ||
				! fieldNames( block.blockType ).includes( attribute )
			) {
				continue;
			}

			const currentText = ( block.fields[ attribute ] ?? EMPTY_FIELD )
				.text;
			const nextText = fieldOf( value ).text;

			/*
			 * A split: the text got shorter, and a new block of the same
			 * type, with no children and the rest of the text, is right
			 * after it.
			 */
			if ( final.parents.has( syncId ) ) {
				const siblings =
					final.children.get( final.parents.get( syncId ) ?? null ) ??
					[];
				const tailId = siblings[ siblings.indexOf( syncId ) + 1 ];
				const tail =
					undefined === tailId ? undefined : newBlocks.get( tailId );

				if (
					undefined !== tailId &&
					tail &&
					tail.name === block.blockType &&
					0 === ( final.children.get( tailId ) ?? [] ).length
				) {
					const tailText = fieldOf(
						tail.attributes[ attribute ]
					).text;

					if (
						'' !== tailText &&
						currentText !== nextText &&
						currentText === nextText + tailText &&
						emit( 'split_block', {
							syncId,
							field: attribute,
							offset: nextText.length,
							newSyncId: tailId,
						} )
					) {
						newBlocks.delete( tailId );
						replaced.set( tailId, tail );
						created.add( tailId );
						continue;
					}
				}
			}

			/*
			 * A merge: the text grew by exactly the text of the block that
			 * came right after it, and that block is gone.
			 */
			const originalSiblings =
				original.children.get(
					original.parents.get( syncId ) ?? null
				) ?? [];
			const absorbedId =
				originalSiblings[ originalSiblings.indexOf( syncId ) + 1 ];
			const absorbed =
				undefined === absorbedId
					? null
					: getBlock( working, absorbedId );

			if (
				undefined !== absorbedId &&
				absorbed &&
				! reachable.has( absorbedId ) &&
				0 === absorbed.children.length
			) {
				const absorbedText = (
					absorbed.fields[ attribute ] ?? EMPTY_FIELD
				).text;

				if (
					'' !== absorbedText &&
					nextText === currentText + absorbedText
				) {
					emit( 'merge_blocks', {
						survivorId: syncId,
						absorbedId,
						field: attribute,
						joinOffset: currentText.length,
					} );
				}
			}
		}

		/*
		 * Bring the document's structure to the final one. Each parent is
		 * handled from the top down, its children from first to last. A
		 * new block is inserted after the block that ends up before it. A
		 * block that stays in its parent and keeps its place among the
		 * others does not move (see pickUnmoved). Every other block moves
		 * to its place.
		 */
		const placeChildren = ( parentId: string | null ) => {
			const wanted = final.children.get( parentId ) ?? [];
			const present = childIdsIn( working, parentId ) ?? [];

			if ( ! sameValue( wanted, present ) ) {
				const positions = new Map(
					present.map( ( id, index ) => [ id, index ] )
				);
				const unmoved = pickUnmoved(
					wanted.filter( ( id ) => positions.has( id ) ),
					positions,
					relocated
				);
				let previousId: string | null = null;

				for ( const syncId of wanted ) {
					const pending = newBlocks.get( syncId );

					if ( pending && ! getBlock( working, syncId ) ) {
						const inserted = emit( 'insert_block', {
							block: blockToEngineSpec(
								bridgeBlockFor( syncId, pending, true ),
								richTextFields,
								undefined,
								undefined,
								rawContent,
								saveMarkup
							),
							parentId,
							afterSiblingId: previousId,
						} );

						if ( ! inserted ) {
							// The block is not in the document, so nothing
							// can go after it.
							continue;
						}
					} else if ( ! unmoved.has( syncId ) ) {
						const moved = emit( 'move_block', {
							syncId,
							newParentId: parentId,
							afterSiblingId: previousId,
						} );

						if ( ! moved ) {
							continue;
						}
					}

					previousId = syncId;
				}
			}

			for ( const syncId of wanted ) {
				if ( getBlock( working, syncId ) ) {
					placeChildren( syncId );
				}
			}
		};

		placeChildren( null );

		for ( const syncId of newBlocks.keys() ) {
			if ( getBlock( working, syncId ) ) {
				created.add( syncId );
			}
		}

		// Remove what is left over, the outermost blocks only: a removed
		// block takes everything inside it along.
		const leftOver: string[] = [];
		const gone: string[] = [];
		const collectGone = ( blocks: EngineBlock[] ) => {
			for ( const block of blocks ) {
				gone.push( block.syncId );
				collectGone( block.children );
			}
		};
		const findLeftOver = ( blocks: EngineBlock[] ) => {
			for ( const block of blocks ) {
				if ( reachable.has( block.syncId ) ) {
					findLeftOver( block.children );
				} else {
					leftOver.push( block.syncId );
					collectGone( [ block ] );
				}
			}
		};

		findLeftOver( working.root );

		for ( const syncId of leftOver ) {
			emit( 'remove_block', { syncId } );
		}

		for ( const syncId of gone ) {
			ids.unlinkSyncId( syncId );
		}
	}

	/*
	 * Blocks the document holds that arrived whole: compare each with the
	 * document, one block at a time.
	 */
	for ( const [ syncId, pending ] of replaced ) {
		const block = getBlock( working, syncId );

		if ( ! block ) {
			continue;
		}

		if ( pending.name !== block.blockType ) {
			emit( 'transform_block', { syncId, newBlockType: pending.name } );
		}

		const spec = blockToEngineSpec(
			bridgeBlockFor( syncId, pending, false ),
			richTextFields,
			undefined,
			undefined,
			rawContent,
			saveMarkup
		);
		const attrs = spec.attrs ?? {};
		const defaults = context.attributeDefaults?.( pending.name ) ?? {};

		for ( const [ key, value ] of Object.entries( attrs ) ) {
			if ( undefined === value ) {
				continue;
			}

			const isSet = key in block.attrs;

			// A default value the document leaves out is not an edit.
			if (
				! isSet &&
				key in defaults &&
				sameValue( defaults[ key ], value )
			) {
				continue;
			}

			if ( isSet && sameValue( block.attrs[ key ], value ) ) {
				continue;
			}

			emit( 'set_attr', {
				syncId,
				key,
				value,
				observedVersion: block.attrVersions[ key ] ?? 0,
			} );
		}

		for ( const key of Object.keys( block.attrs ) ) {
			// Attributes the engine keeps for itself start with "_". The
			// editor never holds them.
			if ( ! ( key in attrs ) && ! key.startsWith( '_' ) ) {
				emit( 'remove_attr', {
					syncId,
					key,
					observedVersion: block.attrVersions[ key ] ?? 0,
				} );
			}
		}

		for ( const [ name, field ] of Object.entries( spec.fields ?? {} ) ) {
			captureField(
				syncId,
				name,
				{ text: field.text ?? '', formats: field.formats ?? [] },
				undefined,
				{}
			);
		}
	}

	/*
	 * Changes to single attributes, in the order they were made. A batch
	 * names only what changed, so an unchanged value is never sent.
	 */
	const needsSavedMarkup = new Set< string >();

	for ( const change of changes ) {
		const block = getBlock( working, change.syncId );

		if ( ! block ) {
			continue;
		}

		const { syncId } = change;

		if ( 'name' === change.kind ) {
			if ( block.blockType !== change.value ) {
				emit( 'transform_block', {
					syncId,
					newBlockType: change.value,
				} );
				needsSavedMarkup.add( syncId );
			}

			continue;
		}

		if ( 'innerContent' === change.kind ) {
			if ( rawContent?.is( block.blockType ) ) {
				captureField(
					syncId,
					'content',
					htmlToField( change.value ),
					undefined,
					{}
				);
			}

			continue;
		}

		const { attribute } = change;
		const names = fieldNames( block.blockType );

		if ( names.includes( attribute ) ) {
			const key = `${ syncId }\n${ attribute }`;
			let hint: CaretHint = {};

			// The caret explains one change. With several changes to one
			// text in a batch, it explains none of them for sure.
			if ( 1 === changeCounts.get( key ) ) {
				hint = caretHint(
					context.selection,
					context.previousSelection,
					change.clientId,
					attribute
				);
			}

			captureField(
				syncId,
				attribute,
				fieldOf( change.value ),
				fieldOf( change.previousValue ),
				hint
			);

			// The saved markup of a block with no `content` field is kept
			// as a whole, so a change to another text changes it.
			if ( ! names.includes( 'content' ) ) {
				needsSavedMarkup.add( syncId );
			}

			continue;
		}

		let value = serializeAttribute( change.value );
		let previousValue = serializeAttribute( change.previousValue );

		if ( 'metadata' === attribute ) {
			value = withoutSyncId( value );
			previousValue = withoutSyncId( previousValue );
		}

		const isSet = attribute in block.attrs;
		const atStart = getBlock( doc, syncId )?.attrs[ attribute ];

		if (
			isSet &&
			undefined !== previousValue &&
			! sameValue( block.attrs[ attribute ], previousValue ) &&
			! sameValue( atStart, previousValue )
		) {
			counters.stalePreviousValue++;
		}

		if ( undefined === value ) {
			if ( isSet ) {
				emit( 'remove_attr', {
					syncId,
					key: attribute,
					observedVersion: block.attrVersions[ attribute ] ?? 0,
				} );
				needsSavedMarkup.add( syncId );
			}

			continue;
		}

		if ( isSet && sameValue( block.attrs[ attribute ], value ) ) {
			continue;
		}

		emit( 'set_attr', {
			syncId,
			key: attribute,
			value,
			observedVersion: block.attrVersions[ attribute ] ?? 0,
		} );
		needsSavedMarkup.add( syncId );
	}

	/*
	 * Saved markup. The server writes a block's wrapper element as the
	 * browser last rendered it, and for a block with no `content` field it
	 * writes the whole inner markup that way. So a change that can alter
	 * the markup renders it again, for that one block.
	 */
	if ( saveMarkup ) {
		for ( const syncId of needsSavedMarkup ) {
			const block = getBlock( working, syncId );

			if (
				! block ||
				created.has( syncId ) ||
				replaced.has( syncId ) ||
				rawContent?.is( block.blockType )
			) {
				continue;
			}

			const spec = blockToEngineSpec(
				engineBlockToBlock(
					{ ...block, children: [] },
					richTextFields,
					rawContent
				),
				richTextFields,
				undefined,
				undefined,
				rawContent,
				saveMarkup
			);
			const wrapper = spec.attrs?._wrapper;

			if (
				undefined !== wrapper &&
				! sameValue( block.attrs._wrapper, wrapper )
			) {
				emit( 'set_attr', {
					syncId,
					key: '_wrapper',
					value: wrapper,
					observedVersion: block.attrVersions._wrapper ?? 0,
				} );
			}

			const content = spec.fields?.content;

			if (
				content &&
				! richTextFields( block.blockType ).includes( 'content' )
			) {
				captureField(
					syncId,
					'content',
					{
						text: content.text ?? '',
						formats: content.formats ?? [],
					},
					undefined,
					{}
				);
			}
		}
	}

	return {
		intents,
		doc: working,
		counters,
		identityNeedsWrite,
		rawContentToRefresh: [ ...rawContentToRefresh ].filter( ( syncId ) =>
			getBlock( working, syncId )
		),
	};
}
