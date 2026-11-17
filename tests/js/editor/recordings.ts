/**
 * External dependencies
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Internal dependencies
 */
import {
	blockToEngineSpec,
	type BridgeBlock,
} from '../../../src/engines/intent-log-bridge';
import { createDocument } from '../../../src/engines/intent-log/document.js';
import { htmlToField } from '../../../src/engines/intent-log/rich-text.js';
import type {
	EngineBlock,
	EngineDocument,
	EngineField,
} from '../../../src/engines/intent-log/engine-types';
import {
	captureBlockOperations,
	type CaptureCounters,
	type CapturedIntent,
} from '../../../src/editor/capture';
import type {
	BlockOperation,
	EditBatch,
	EditorBlock,
	EditorSelection,
} from '../../../src/editor/gutenberg-contract';
import {
	createBlockIdentityTable,
	type BlockIdentityTable,
} from '../../../src/editor/identity';

/*
 * Helpers that replay the recorded edit batches in
 * tests/fixtures/edit-batches/ through capture. Each recording holds what
 * a real editor sent for one action, with the block tree before and after
 * each batch. tests/tools/edit-batch-recorder/README.md describes the
 * file format.
 */

const FIXTURES = join( __dirname, '..', '..', 'fixtures', 'edit-batches' );

/** One recorded call. */
export interface RecordedEvent {
	call: string;
	kind?: string;
	name?: string;
	recordId?: string | number;
	batch?: EditBatch;
	tree?: EditorBlock[] | null;
	treeBefore?: EditorBlock[];
	treeAfter?: EditorBlock[];
}

/** One recording. */
export interface Recording {
	scenario: string;
	description: string;
	startupEvents: RecordedEvent[];
	events: RecordedEvent[];
}

/**
 * Brings back the values JSON cannot hold: rich text objects and
 * undefined.
 *
 * @param value A value from a recording.
 * @return The value as the editor held it.
 */
function revive( value: unknown ): unknown {
	if ( Array.isArray( value ) ) {
		return value.map( revive );
	}

	if ( ! value || 'object' !== typeof value ) {
		return value;
	}

	const record: Record< string, unknown > = { ...value };

	if ( 'RichTextData' === record.__type ) {
		const html = String( record.html );

		return { toHTMLString: () => html, text: record.text };
	}

	if ( 'undefined' === record.__type ) {
		return undefined;
	}

	if ( 'function' === record.__type ) {
		return () => undefined;
	}

	for ( const key of Object.keys( record ) ) {
		record[ key ] = revive( record[ key ] );
	}

	return record;
}

/**
 * The names of every recording.
 *
 * @return The names, without the file ending.
 */
export function listRecordings(): string[] {
	return readdirSync( FIXTURES )
		.filter( ( file ) => file.endsWith( '.json' ) && 'facts.json' !== file )
		.map( ( file ) => file.replace( /\.json$/, '' ) )
		.sort();
}

/**
 * Loads one recording.
 *
 * @param name The recording's name.
 * @return The recording.
 */
export function loadRecording( name: string ): Recording {
	// The file is trusted test data with the shape the recorder writes.
	return revive(
		JSON.parse( readFileSync( join( FIXTURES, `${ name }.json` ), 'utf8' ) )
	) as Recording;
}

/** What the engine holds for one record while a recording is replayed. */
export interface ReplayedRecord {
	doc: EngineDocument;
	ids: BlockIdentityTable;
	previousSelection?: EditorSelection;
}

/** What one replayed batch gave. */
export interface ReplayedBatch {
	event: RecordedEvent;
	/** The engine's document right after the batch. */
	doc: EngineDocument;
	/** The engine's document right after the batch, reduced. */
	document: ComparableBlock[];
	/**
	 * The editor's tree right after the batch, reduced. Undefined when the
	 * recording holds no tree for the batch.
	 */
	editor?: ComparableBlock[];
	intents: CapturedIntent[];
	counters: CaptureCounters;
	identityNeedsWrite: boolean;
}

/**
 * An editor block in the shape the bridge reads, carrying a lasting id.
 *
 * @param block The editor block.
 * @param ids   The id table. A block it does not know gets a new id.
 * @param mint  Makes a new id.
 * @return The block.
 */
function toBridgeBlock(
	block: EditorBlock,
	ids: BlockIdentityTable,
	mint: () => string
): BridgeBlock {
	let syncId = ids.getSyncId( block.clientId );

	if ( undefined === syncId ) {
		syncId = mint();
		ids.link( block.clientId, syncId );
	}

	const bridge: BridgeBlock = {
		name: block.name,
		attributes: { ...block.attributes, metadata: { syncId } },
		innerBlocks: block.innerBlocks.map( ( child ) =>
			toBridgeBlock( child, ids, mint )
		),
	};

	if ( block.innerContent ) {
		bridge.innerContent = block.innerContent;
	}

	return bridge;
}

/**
 * Starts a record from an editor block tree: gives every block a lasting
 * id, links it in a new id table, and builds the document.
 *
 * @param tree The editor's blocks.
 * @param mint Makes a new id.
 * @return The document and the id table.
 */
export function seedRecord(
	tree: EditorBlock[],
	mint: () => string
): ReplayedRecord {
	const ids = createBlockIdentityTable();
	const blocks = tree.map( ( block ) => toBridgeBlock( block, ids, mint ) );

	return {
		ids,
		doc: createDocument(
			blocks.map( ( block ) => blockToEngineSpec( block ) )
		),
	};
}

/**
 * A short description of a batch's edits, such as
 * "insert_block x3, remove_block".
 *
 * @param intents The edits.
 * @return The edit types in order of first use, with a count when a type
 *         is used more than once.
 */
export function summarize( intents: CapturedIntent[] ): string {
	const counts = new Map< string, number >();

	for ( const intent of intents ) {
		counts.set( intent.type, ( counts.get( intent.type ) ?? 0 ) + 1 );
	}

	return [ ...counts ]
		.map( ( [ type, count ] ) => {
			if ( count > 1 ) {
				return `${ type } x${ count }`;
			}

			return type;
		} )
		.join( ', ' );
}

/**
 * Replays a recording through capture.
 *
 * Every record starts from the block tree core-data passed to `load`,
 * with the lasting ids b1, b2, and so on. Batches for a record that was
 * never loaded are skipped, as the engine skips them.
 *
 * @param recording The recording.
 * @return One entry per batch that held a block operation.
 */
export function replay( recording: Recording ): ReplayedBatch[] {
	const records = new Map< string, ReplayedRecord >();
	const results: ReplayedBatch[] = [];
	let nextId = 0;
	const mint = () => `b${ ++nextId }`;

	for ( const event of [ ...recording.startupEvents, ...recording.events ] ) {
		const key = `${ event.kind }/${ event.name }/${ event.recordId }`;

		if ( 'load' === event.call ) {
			if ( Array.isArray( event.tree ) && ! records.has( key ) ) {
				records.set( key, seedRecord( event.tree, mint ) );
			}

			continue;
		}

		const record = records.get( key );

		if ( 'applyEditBatch' !== event.call || ! event.batch || ! record ) {
			continue;
		}

		const operations = event.batch.operations.filter(
			( operation ): operation is BlockOperation =>
				'set-field' !== operation.type
		);

		if ( operations.length > 0 ) {
			const captured = captureBlockOperations( record.doc, operations, {
				ids: record.ids,
				richTextFields: () => [ 'content' ],
				selection: event.batch.selection,
				previousSelection: record.previousSelection,
				mintId: mint,
			} );

			record.doc = captured.doc;
			results.push( {
				event,
				doc: captured.doc,
				document: comparableDocument( captured.doc.root ),
				editor: event.treeAfter
					? comparableTree( event.treeAfter, record.ids )
					: undefined,
				intents: captured.intents,
				counters: captured.counters,
				identityNeedsWrite: captured.identityNeedsWrite,
			} );
		}

		record.previousSelection = event.batch.selection;
	}

	return results;
}

/** A block reduced to what the editor and the document must agree on. */
export interface ComparableBlock {
	syncId: string | undefined;
	type: string;
	attrs: Record< string, unknown >;
	content: EngineField;
	children: ComparableBlock[];
}

const sortedField = ( field: EngineField | undefined ): EngineField => ( {
	text: field?.text ?? '',
	formats: [ ...( field?.formats ?? [] ) ].sort(
		( a, b ) =>
			a.start - b.start ||
			a.end - b.end ||
			a.format.localeCompare( b.format )
	),
} );

/**
 * The editor's tree, reduced for comparison.
 *
 * @param blocks The editor's blocks.
 * @param ids    The id table.
 * @return The reduced tree.
 */
export function comparableTree(
	blocks: EditorBlock[],
	ids: BlockIdentityTable
): ComparableBlock[] {
	return blocks.map( ( block ) => {
		const attrs: Record< string, unknown > = {};
		let content = '';

		for ( const [ key, value ] of Object.entries( block.attributes ) ) {
			let plain = value;

			if (
				value &&
				'object' === typeof value &&
				'toHTMLString' in value &&
				'function' === typeof value.toHTMLString
			) {
				plain = value.toHTMLString();
			}

			if ( 'content' === key ) {
				content = 'string' === typeof plain ? plain : '';
			} else if ( undefined !== plain ) {
				attrs[ key ] = plain;
			}
		}

		return {
			syncId: ids.getSyncId( block.clientId ),
			type: block.name,
			attrs,
			content: sortedField( htmlToField( content ) ),
			children: comparableTree( block.innerBlocks, ids ),
		};
	} );
}

/**
 * The engine's document, reduced for comparison.
 *
 * @param blocks The document's blocks.
 * @return The reduced tree.
 */
export function comparableDocument( blocks: EngineBlock[] ): ComparableBlock[] {
	return blocks.map( ( block ) => ( {
		syncId: block.syncId,
		type: block.blockType,
		attrs: Object.fromEntries(
			Object.entries( block.attrs ).filter(
				( [ key ] ) => ! key.startsWith( '_' )
			)
		),
		content: sortedField( block.fields.content ),
		children: comparableDocument( block.children ),
	} ) );
}
