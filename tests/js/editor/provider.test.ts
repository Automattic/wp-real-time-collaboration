/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';

/**
 * WordPress dependencies
 */
import { addFilter, removeFilter } from '@wordpress/hooks';

/**
 * Internal dependencies
 */
import {
	createDocument,
	getBlock,
} from '../../../src/engines/intent-log/document.js';
import type { BlockSpec } from '../../../src/engines/intent-log/document.js';
import { INTENT_LOG_UPDATE_TYPES } from '../../../src/engines/intent-log-session';
import type {
	EditBatch,
	EditOperation,
	EditorBlock,
	EditorSelection,
	EntitySyncContext,
	EntitySyncRecord,
	EntitySyncRecordHandlers,
} from '../../../src/editor/gutenberg-contract';
import {
	createIntentLogProvider,
	type IntentLogProviderOptions,
} from '../../../src/editor/provider';
import { resetProviderCreatorsForTesting } from '../../../src/registry/transports';
import type {
	EngineSessionCodec,
	ProviderCreator,
} from '../../../src/registry/types';
import {
	connectToWire,
	createWireServer,
	type WireLink,
	type WireServer,
} from './wire';

/*
 * The provider, driven the way core-data drives it: a record is loaded,
 * edit batches arrive, and the provider writes back through `editRecord`.
 * The server and the transport are the stand-ins in wire.ts, so a test
 * decides when the server's answers arrive (`poll()`).
 *
 * Block registration is the editor's own state. The stand-in below knows
 * no block type, so every block has one text attribute, `content`, and no
 * saved markup.
 */
jest.mock( '@wordpress/blocks', () => {
	const strip = ( block: {
		name: string;
		attributes: unknown;
		innerBlocks?: unknown[];
	} ): unknown => ( {
		name: block.name,
		attributes: block.attributes,
		innerBlocks: ( block.innerBlocks ?? [] ).map( ( child ) =>
			strip( child as Parameters< typeof strip >[ 0 ] )
		),
	} );

	return {
		getBlockType: () => undefined,
		getBlockContent: () => '',
		getSaveContent: () => '',
		serialize: ( blocks: Array< Parameters< typeof strip >[ 0 ] > ) =>
			JSON.stringify( blocks.map( strip ) ),
		serializeRawBlock: () => '',
		parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	};
} );

const FILTER = 'sync.providers';
const NAMESPACE = 'wp-real-time-collaboration/provider-test';

/** The server every tab of the current test connects to. */
let wire: WireServer;
/** The connection of every session the provider made, in order. */
let links: Array< { session: EngineSessionCodec; link: WireLink } > = [];

const transport: ProviderCreator = async ( { session } ) => {
	// The session is the intent-log session the provider made.
	links.push( {
		session,
		link: connectToWire(
			wire,
			session as Parameters< typeof connectToWire >[ 1 ]
		),
	} );

	return { destroy: () => {}, on: () => {} };
};

const context: EntitySyncContext = {
	getSyncConfig: ( kind ) => {
		if ( 'postType' === kind || 'taxonomy' === kind ) {
			return {};
		}

		return undefined;
	},
	recordHandlers: () => ( { onStatusChange: () => {} } ),
	collectionHandlers: () => ( { onStatusChange: () => {} } ),
};

/**
 * An editor paragraph.
 *
 * @param clientId The editor's id for the block.
 * @param content  The text.
 * @param syncId   The lasting id saved in the block, if any.
 * @return The block.
 */
function paragraph(
	clientId: string,
	content: string,
	syncId?: string
): EditorBlock {
	const attributes: Record< string, unknown > = { content, dropCap: false };

	if ( syncId ) {
		attributes.metadata = { syncId };
	}

	return { clientId, name: 'core/paragraph', attributes, innerBlocks: [] };
}

/**
 * A paragraph in the room's first document. Like the server's first copy
 * of a post, it leaves out default attribute values.
 *
 * @param syncId The lasting id.
 * @param text   The text.
 * @return The block.
 */
function roomParagraph( syncId: string, text: string ): BlockSpec {
	return { syncId, blockType: 'core/paragraph', text };
}

/** One editor tab, with the provider behind it. */
interface Tab {
	provider: ReturnType< typeof createIntentLogProvider >;
	link: WireLink;
	/** Every `editRecord` call, oldest first. */
	pushes: EntitySyncRecord[];
	/** The blocks the editor holds: the loaded ones, then each push. */
	blocks: () => EditorBlock[];
	undoLevels: jest.Mock;
	/** Sends a batch of operations as core-data would. */
	edit: (
		operations: EditOperation[],
		batchOptions?: Partial< EditBatch[ 'options' ] >,
		selection?: EditorSelection
	) => void;
	/** Types text at the end of a paragraph's content. */
	type: ( clientId: string, before: string, after: string ) => void;
	/** One exchange with the server, then the tasks that were scheduled. */
	sync: () => void;
}

/**
 * Opens a post in a new tab.
 *
 * @param blocks  The blocks the editor parsed from the saved post.
 * @param record  More fields of the record.
 * @param options Provider options.
 * @return The tab.
 */
async function openTab(
	blocks: EditorBlock[],
	record: EntitySyncRecord = {},
	options: IntentLogProviderOptions = {}
): Promise< Tab > {
	const pushes: EntitySyncRecord[] = [];
	let editorBlocks = blocks;
	const undoLevels = jest.fn();
	const handlers: EntitySyncRecordHandlers = {
		editRecord: ( edits ) => {
			pushes.push( edits );

			if ( Array.isArray( edits.blocks ) ) {
				editorBlocks = edits.blocks;
			}
		},
		getEditedRecord: async () => ( {} ),
		refetchRecord: async () => {},
		onUndoLevelOpened: undoLevels,
	};
	const provider = createIntentLogProvider( context, {
		fetchTaxonomies: async () => [],
		flushBeforeSave: async () => {},
		...options,
	} );
	const before = links.length;

	await provider.load(
		'postType',
		'post',
		1,
		{
			title: { raw: 'Title' },
			status: 'draft',
			meta: {},
			...record,
			blocks,
		},
		handlers
	);

	const { link } = links[ before ];
	const sync = () => {
		link.poll();
		jest.runOnlyPendingTimers();
	};

	sync();

	return {
		provider,
		link,
		pushes,
		blocks: () => editorBlocks,
		undoLevels,
		edit: ( operations, batchOptions = {}, selection ) =>
			provider.applyEditBatch( 'postType', 'post', 1, {
				operations,
				options: {
					isCached: false,
					undoIgnore: false,
					...batchOptions,
				},
				selection,
			} ),
		type: ( clientId, previousValue, value ) =>
			provider.applyEditBatch( 'postType', 'post', 1, {
				operations: [
					{
						type: 'set-attribute',
						clientId,
						attribute: 'content',
						previousValue,
						value,
					},
				],
				options: { isCached: false, undoIgnore: false },
			} ),
		sync,
	};
}

const serverText = ( syncId: string ) =>
	getBlock( wire.doc(), syncId )?.fields.content.text;

const serverOrder = () => wire.doc().root.map( ( block ) => block.syncId );

beforeEach( () => {
	jest.useFakeTimers();
	(
		window as { __experimentalEnableRealTimeCollaboration?: boolean }
	 ).__experimentalEnableRealTimeCollaboration = true;
	(
		window as { _wpCollaborationUserId?: number }
	 )._wpCollaborationUserId = 7;
	resetProviderCreatorsForTesting();
	addFilter( FILTER, NAMESPACE, () => [ transport ] );
	links = [];
	wire = createWireServer( [
		roomParagraph( 'p1', 'One' ),
		roomParagraph( 'p2', 'Two' ),
	] );
} );

afterEach( () => {
	removeFilter( FILTER, NAMESPACE );
	resetProviderCreatorsForTesting();
	jest.useRealTimers();
} );

describe( 'provider: loading a record', () => {
	it( 'writes the lasting ids into the editor’s blocks and keeps their clientIds', async () => {
		// A post nobody has edited together: the saved blocks carry no id.
		const tab = await openTab( [
			paragraph( 'c-1', 'One' ),
			paragraph( 'c-2', 'Two' ),
		] );

		expect( tab.pushes ).toHaveLength( 1 );
		expect(
			tab
				.blocks()
				.map( ( block ) => [
					block.clientId,
					block.attributes.metadata,
				] )
		).toEqual( [
			[ 'c-1', { syncId: 'p1' } ],
			[ 'c-2', { syncId: 'p2' } ],
		] );
		expect(
			tab.blocks().every( ( block ) => true === block.isValid )
		).toBe( true );
	} );

	it( 'matches blocks by their saved id, not by their place', async () => {
		const tab = await openTab( [
			paragraph( 'c-b', 'Two', 'p2' ),
			paragraph( 'c-a', 'One', 'p1' ),
		] );

		// The document's order wins, and each block keeps its clientId.
		expect( tab.blocks().map( ( block ) => block.clientId ) ).toEqual( [
			'c-a',
			'c-b',
		] );
	} );

	it( 'does not load a record of a kind core-data does not sync', async () => {
		const provider = createIntentLogProvider( context );

		await provider.load(
			'root',
			'site',
			1,
			{},
			{
				editRecord: () => {},
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoLevelOpened: () => {},
			}
		);

		expect( provider.isLoaded?.( 'root', 'site', 1 ) ).toBe( false );
		expect( provider.shouldSync?.( 'root', 'site', 1 ) ).toBe( false );
		expect( links ).toHaveLength( 0 );
	} );

	it( 'writes nothing into a record that is not a post when it connects', async () => {
		// A category has no blocks. Handing it an empty block list would
		// leave it with unsaved changes, and the Publish button would
		// read "Save".
		wire = createWireServer( [] );

		const pushes: EntitySyncRecord[] = [];
		const provider = createIntentLogProvider( context );

		await provider.load(
			'taxonomy',
			'category',
			1,
			{ name: 'Uncategorized' },
			{
				editRecord: ( edits ) => {
					pushes.push( edits );
				},
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoLevelOpened: () => {},
			}
		);

		links[ 0 ].link.poll();
		jest.runOnlyPendingTimers();

		expect( provider.isLoaded?.( 'taxonomy', 'category', 1 ) ).toBe( true );
		expect( pushes ).toEqual( [] );
	} );

	it( 'ignores a batch for a record it has not loaded', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One' ) ] );

		expect( () =>
			tab.provider.applyEditBatch( 'postType', 'wp_template_part', 'x', {
				operations: [],
				options: { isCached: false, undoIgnore: false },
			} )
		).not.toThrow();
		expect( () =>
			tab.provider.applyEditBatch( 'postType', 'post', undefined, {
				operations: [],
				options: { isCached: false, undoIgnore: false },
			} )
		).not.toThrow();
	} );

	it( 'forgets a record when it is unloaded', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One' ) ] );

		expect( tab.provider.isLoaded?.( 'postType', 'post', 1 ) ).toBe( true );

		tab.provider.unload( 'postType', 'post', 1 );

		expect( tab.provider.isLoaded?.( 'postType', 'post', 1 ) ).toBe(
			false
		);
	} );
} );

describe( 'provider: local edits', () => {
	it( 'sends typed text to the server and does not push it back', async () => {
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );
		const pushesBefore = tab.pushes.length;

		tab.type( 'c-1', 'One', 'One!' );
		tab.sync();

		expect( serverText( 'p1' ) ).toBe( 'One!' );
		// The editor already shows the text. The server's answer changes
		// nothing for it.
		expect( tab.pushes ).toHaveLength( pushesBefore );
	} );

	it( 'never writes to the editor during applyEditBatch', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );
		const pushesBefore = tab.pushes.length;

		// Enter in the middle: the new block has no lasting id yet.
		tab.edit( [
			{
				type: 'set-attribute',
				clientId: 'c-1',
				attribute: 'content',
				previousValue: 'One',
				value: 'O',
			},
			{
				type: 'insert',
				block: paragraph( 'c-new', 'ne' ),
				parent: null,
				before: null,
			},
		] );

		expect( tab.pushes ).toHaveLength( pushesBefore );

		// The id is written in a later task.
		jest.runOnlyPendingTimers();

		expect( tab.pushes ).toHaveLength( pushesBefore + 1 );

		const added = tab
			.blocks()
			.find( ( block ) => 'ne' === block.attributes.content );

		expect( added?.clientId ).toBe( 'c-new' );
		expect( added?.attributes.metadata ).toEqual( {
			syncId: expect.any( String ),
		} );
	} );

	it( 'does not send default attribute values with the first edit', async () => {
		/*
		 * The room's first document leaves out a paragraph's
		 * `dropCap: false`. The editor's blocks carry it. Two people who
		 * each type in their own paragraph must not get a review card.
		 */
		const alice = await openTab( [
			paragraph( 'a-1', 'One' ),
			paragraph( 'a-2', 'Two' ),
		] );
		const bob = await openTab( [
			paragraph( 'b-1', 'One' ),
			paragraph( 'b-2', 'Two' ),
		] );

		alice.type( 'a-1', 'One', 'One from Alice' );
		bob.type( 'b-2', 'Two', 'Two from Bob' );
		alice.sync();
		bob.sync();
		alice.sync();

		expect( serverText( 'p1' ) ).toBe( 'One from Alice' );
		expect( serverText( 'p2' ) ).toBe( 'Two from Bob' );
		expect(
			alice.provider.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
		expect(
			bob.provider.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'keeps a batch that arrives before the room’s first document', async () => {
		const provider = createIntentLogProvider( context, {
			fetchTaxonomies: async () => [],
		} );
		const pushes: EntitySyncRecord[] = [];

		await provider.load(
			'postType',
			'post',
			1,
			{ blocks: [ paragraph( 'c-1', 'One', 'p1' ) ] },
			{
				editRecord: ( edits ) => pushes.push( edits ),
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoLevelOpened: () => {},
			}
		);

		// The person types before the server has answered at all.
		provider.applyEditBatch( 'postType', 'post', 1, {
			operations: [
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'One',
					value: 'One early',
				},
			],
			options: { isCached: false, undoIgnore: false },
		} );

		const { link } = links[ 0 ];

		link.poll();
		jest.runOnlyPendingTimers();
		link.poll();

		expect( serverText( 'p1' ) ).toBe( 'One early' );
		// The first push holds the early text, not the text without it.
		expect( pushes.at( -1 )?.blocks ).toMatchObject( [
			{ attributes: { content: 'One early' } },
			{ attributes: { content: 'Two' } },
		] );
	} );

	it( 'sends the editor’s blocks along with the first edit when the room started empty', async () => {
		wire = createWireServer( [] );

		// A new post whose editor starts with blocks from a template.
		const tab = await openTab( [
			paragraph( 'c-1', 'From the template' ),
			paragraph( 'c-2', '' ),
		] );

		// The empty room is not pushed over the editor's blocks.
		expect( tab.pushes ).toEqual( [] );

		tab.type( 'c-2', '', 'Hello' );
		tab.sync();

		expect(
			wire.doc().root.map( ( block ) => block.fields.content.text )
		).toEqual( [ 'From the template', 'Hello' ] );
	} );

	it( 'captures an edit made in the code editor from the raw text', async () => {
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );

		// The stand-in parser reads the text as JSON.
		tab.edit( [
			{
				type: 'set-field',
				field: 'content',
				previousValue: 'old text',
				value: JSON.stringify( [
					{
						name: 'core/paragraph',
						attributes: {
							content: 'One changed',
							metadata: { syncId: 'p1' },
						},
						innerBlocks: [],
					},
				] ),
			},
		] );
		tab.sync();

		expect( serverOrder() ).toEqual( [ 'p1' ] );
		expect( serverText( 'p1' ) ).toBe( 'One changed' );
	} );

	it( 'does not take the content the editor writes when it saves for an edit', async () => {
		/*
		 * Each save, the editor writes the whole content as text into the
		 * record, marked as not to be undone. The text is made from the
		 * blocks, whose edits the engine already has. Comparing it with
		 * the document would send whatever the text and the document
		 * spell differently, from every tab that saves.
		 */
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );
		const rowsBefore = wire.rowCount();

		tab.edit(
			[
				{
					type: 'set-field',
					field: 'content',
					previousValue: 'old text',
					value: JSON.stringify( [
						{
							name: 'core/paragraph',
							attributes: {
								content: 'Spelled differently',
								metadata: { syncId: 'p1' },
							},
							innerBlocks: [],
						},
					] ),
				},
			],
			{ undoIgnore: true }
		);
		tab.sync();

		expect( wire.rowCount() ).toBe( rowsBefore );
		expect( serverOrder() ).toEqual( [ 'p1', 'p2' ] );
		expect( serverText( 'p1' ) ).toBe( 'One' );
	} );

	it( 'does not add a block a second time when a batch inserts a block the document already holds', async () => {
		/*
		 * After a save, core-data can lose the block list it compares
		 * against. Its next comparison then starts from nothing, or from
		 * blocks parsed afresh from the saved text, and reports every
		 * block of the editor as inserted. Those blocks are the ones the
		 * document holds already.
		 */
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );

		tab.edit( [
			{
				type: 'insert',
				block: paragraph( 'c-2', 'Two', 'p2' ),
				parent: null,
				before: null,
			},
			{
				type: 'insert',
				block: paragraph( 'c-1', 'One more', 'p1' ),
				parent: null,
				before: 'c-2',
			},
		] );
		tab.sync();

		expect( serverOrder() ).toEqual( [ 'p1', 'p2' ] );
		expect( serverText( 'p1' ) ).toBe( 'One more' );
		expect( serverText( 'p2' ) ).toBe( 'Two' );
	} );

	it( 'keeps one block for text typed in the code editor, keystroke after keystroke', async () => {
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );
		const saved = ( syncId: string, content: string ) => ( {
			name: 'core/paragraph',
			attributes: { content, metadata: { syncId } },
			innerBlocks: [],
		} );
		// Text typed in the code editor has no id.
		const typed = ( content: string ) => ( {
			name: 'core/paragraph',
			attributes: { content },
			innerBlocks: [],
		} );
		const typeInCodeEditor = ( content: string ) => {
			tab.edit( [
				{
					type: 'set-field',
					field: 'content',
					previousValue: 'old text',
					value: JSON.stringify( [
						saved( 'p1', 'One' ),
						saved( 'p2', 'Two' ),
						typed( content ),
					] ),
				},
			] );
			tab.sync();
		};

		typeInCodeEditor( 'Thr' );

		const [ , , newId ] = serverOrder();

		typeInCodeEditor( 'Thre' );
		typeInCodeEditor( 'Three' );

		// The same block all along, not a new one for every keystroke.
		expect( serverOrder() ).toEqual( [ 'p1', 'p2', newId ] );
		expect( serverText( newId ) ).toBe( 'Three' );
	} );

	it( 'counts a batch that names a block it does not know, and puts the editor right', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );
		const pushesBefore = tab.pushes.length;

		tab.type( 'c-unknown', 'One', 'One!' );
		jest.runOnlyPendingTimers();

		expect(
			tab.provider.getCounters( 'postType', 'post', 1 )?.unknownClientId
		).toBe( 1 );
		// The editor is handed the engine's blocks again.
		expect( tab.pushes ).toHaveLength( pushesBefore + 1 );
		expect( serverText( 'p1' ) ).toBe( 'One' );
	} );
} );

describe( 'provider: someone else’s edits', () => {
	it( 'pushes the other person’s text, and only that block is a new object', async () => {
		const alice = await openTab( [
			paragraph( 'a-1', 'One', 'p1' ),
			paragraph( 'a-2', 'Two', 'p2' ),
		] );
		const bob = await openTab( [
			paragraph( 'b-1', 'One', 'p1' ),
			paragraph( 'b-2', 'Two', 'p2' ),
		] );
		const [ firstBefore, secondBefore ] = alice.blocks();

		bob.type( 'b-2', 'Two', 'Two from Bob' );
		bob.sync();
		alice.sync();

		const [ firstAfter, secondAfter ] = alice.blocks();

		expect( secondAfter.attributes.content ).toBe( 'Two from Bob' );
		expect( secondAfter.clientId ).toBe( 'a-2' );
		expect( secondAfter ).not.toBe( secondBefore );
		expect( firstAfter ).toBe( firstBefore );
	} );

	it( 'moves the caret along when text is added in front of it', async () => {
		const alice = await openTab( [ paragraph( 'a-1', 'One', 'p1' ) ] );
		const bob = await openTab( [ paragraph( 'b-1', 'One', 'p1' ) ] );
		const caret = { clientId: 'a-1', attributeKey: 'content', offset: 3 };

		// Alice's caret is at the end of "One".
		alice.edit(
			[],
			{ undoIgnore: true },
			{
				selectionStart: caret,
				selectionEnd: caret,
			}
		);

		bob.edit(
			[
				{
					type: 'set-attribute',
					clientId: 'b-1',
					attribute: 'content',
					previousValue: 'One',
					value: 'Oh, One',
				},
			],
			{},
			{
				selectionStart: {
					clientId: 'b-1',
					attributeKey: 'content',
					offset: 4,
				},
				selectionEnd: {
					clientId: 'b-1',
					attributeKey: 'content',
					offset: 4,
				},
			}
		);
		bob.sync();
		alice.sync();

		expect( alice.pushes.at( -1 )?.selection ).toMatchObject( {
			selectionStart: { clientId: 'a-1', offset: 7 },
			selectionEnd: { clientId: 'a-1', offset: 7 },
		} );
	} );

	it( 'gives a block the other person added a clientId and keeps it', async () => {
		const alice = await openTab( [ paragraph( 'a-1', 'One', 'p1' ) ] );
		const bob = await openTab( [ paragraph( 'b-1', 'One', 'p1' ) ] );

		bob.edit( [
			{
				type: 'insert',
				block: paragraph( 'b-new', 'From Bob' ),
				parent: null,
				before: null,
			},
		] );
		bob.sync();
		alice.sync();

		const added = alice.blocks().at( -1 );

		expect( added?.attributes.content ).toBe( 'From Bob' );

		// Alice types in the new block: the provider knows it.
		alice.type( added?.clientId ?? '', 'From Bob', 'From Bob!' );
		alice.sync();

		const syncId = wire.doc().root.at( -1 )?.syncId ?? '';

		expect( serverText( syncId ) ).toBe( 'From Bob!' );
	} );

	it( 'combines a local edit made while pushes are held with what arrived meanwhile', async () => {
		let held = false;
		const alice = await openTab(
			[ paragraph( 'a-1', 'One', 'p1' ) ],
			{},
			{ isComposing: () => held }
		);
		const bob = await openTab( [ paragraph( 'b-1', 'One', 'p1' ) ] );
		const pushesBefore = alice.pushes.length;

		// Alice is composing text. Nothing may be written to her editor.
		held = true;
		bob.type( 'b-1', 'One', 'Oh, One' );
		bob.sync();
		alice.sync();

		expect( alice.pushes ).toHaveLength( pushesBefore );

		// Her editor still shows "One". She adds "!" at the end of that.
		alice.type( 'a-1', 'One', 'One!' );
		alice.sync();

		expect( serverText( 'p1' ) ).toBe( 'Oh, One!' );
		expect(
			alice.provider.getCounters( 'postType', 'post', 1 )
				?.stalePreviousValue
		).toBe( 0 );

		// The hold ends, and her editor catches up.
		held = false;
		jest.advanceTimersByTime( 300 );

		expect( alice.blocks()[ 0 ].attributes.content ).toBe( 'Oh, One!' );
	} );
} );

describe( 'provider: post fields', () => {
	it( 'sends a changed title and pushes someone else’s title', async () => {
		wire = createWireServer( [ roomParagraph( 'p1', 'One' ) ], {
			title: 'Title',
		} );

		const alice = await openTab( [ paragraph( 'a-1', 'One', 'p1' ) ] );
		const bob = await openTab( [ paragraph( 'b-1', 'One', 'p1' ) ] );

		alice.edit( [
			{
				type: 'set-field',
				field: 'title',
				previousValue: 'Title',
				value: 'A better title',
			},
		] );
		alice.sync();
		bob.sync();

		expect( wire.doc().props?.title ).toBe( 'A better title' );
		expect( bob.pushes.at( -1 ) ).toEqual( { title: 'A better title' } );
		// Alice's own title is not pushed back at her.
		expect( alice.pushes.some( ( edits ) => 'title' in edits ) ).toBe(
			false
		);
	} );

	it( 'sends a field the server changed on save, without an undo step', async () => {
		wire = createWireServer( [ roomParagraph( 'p1', 'One' ) ], {
			slug: 'title',
		} );

		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );

		tab.provider.afterSave?.( 'postType', 'post', 1, {
			savedRecord: { slug: 'title-2', title: { raw: 'Title' } },
			persistedRecord: { slug: 'title', title: { raw: 'Title' } },
			edits: {},
		} );
		tab.sync();

		expect( wire.doc().props?.slug ).toBe( 'title-2' );
		expect( tab.undoLevels ).not.toHaveBeenCalled();
	} );
} );

describe( 'provider: undo', () => {
	it( 'reports one undo step for a typing run and undoes it as one', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );
		const key = (
			previousValue: string,
			value: string,
			isCached: boolean
		) =>
			tab.edit(
				[
					{
						type: 'set-attribute',
						clientId: 'c-1',
						attribute: 'content',
						previousValue,
						value,
					},
				],
				{ isCached }
			);

		key( 'One', 'Onea', false );
		key( 'Onea', 'Oneab', true );
		key( 'Oneab', 'Oneabc', true );
		tab.sync();

		expect( tab.undoLevels ).toHaveBeenCalledTimes( 1 );
		expect( serverText( 'p1' ) ).toBe( 'Oneabc' );

		expect( tab.provider.undoHistory?.undo( 'postType', 'post', 1 ) ).toBe(
			true
		);
		tab.sync();

		expect( serverText( 'p1' ) ).toBe( 'One' );
		// The undo reaches the editor as a push.
		expect( tab.blocks()[ 0 ].attributes.content ).toBe( 'One' );

		expect( tab.provider.undoHistory?.redo( 'postType', 'post', 1 ) ).toBe(
			true
		);
		tab.sync();

		expect( serverText( 'p1' ) ).toBe( 'Oneabc' );
	} );

	it( 'does not make an undo step for a batch core-data marks as ignored', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );

		tab.edit(
			[
				{
					type: 'set-attribute',
					clientId: 'c-1',
					attribute: 'content',
					previousValue: 'One',
					value: 'One!',
				},
			],
			{ undoIgnore: true }
		);
		tab.sync();

		expect( serverText( 'p1' ) ).toBe( 'One!' );
		expect( tab.undoLevels ).not.toHaveBeenCalled();
		expect( tab.provider.undoHistory?.undo( 'postType', 'post', 1 ) ).toBe(
			false
		);
	} );

	it( 'has nothing to undo for a record it has not loaded', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );

		expect( tab.provider.undoHistory?.undo( 'postType', 'page', 9 ) ).toBe(
			false
		);
	} );
} );

describe( 'provider: review', () => {
	it( 'lists an edit the server set aside and applies the reviewer’s decision', async () => {
		const alice = await openTab( [ paragraph( 'a-1', 'One', 'p1' ) ] );
		const bob = await openTab( [ paragraph( 'b-1', 'One', 'p1' ) ] );

		// Both replace the whole text before seeing the other's edit.
		alice.type( 'a-1', 'One', 'Alice' );
		bob.type( 'b-1', 'One', 'Bob' );
		alice.sync();
		bob.sync();
		alice.sync();

		expect( serverText( 'p1' ) ).toBe( 'Alice' );

		const [ conflict ] = bob.provider.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);

		expect( conflict ).toMatchObject( { kind: 'merge', authorId: 7 } );
		// Bob's editor shows the document, not his set-aside text.
		expect( bob.blocks()[ 0 ].attributes.content ).toBe( 'Alice' );

		bob.provider.conflicts.resolveConflict(
			'postType/post',
			'1',
			conflict.id,
			{ action: 'dismiss' }
		);
		bob.sync();

		expect(
			bob.provider.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
		expect( serverText( 'p1' ) ).toBe( 'Alice' );
	} );
} );

describe( 'provider: a room the server starts again', () => {
	it( 'sends the work the editor shows and the new room lacks', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );

		tab.type( 'c-1', 'One', 'One and more' );
		tab.sync();

		// The server throws the room away and builds it again from the
		// saved post, which does not hold the new text.
		const { session } = links[ 0 ];
		const restarted = createWireServer( [ roomParagraph( 'p1', 'One' ) ] );

		wire = restarted;
		( session as { onRoomRestart?: () => void } ).onRoomRestart?.();
		session.receiveUpdate( {
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
			data: JSON.stringify( { doc: restarted.doc() } ),
		} );
		jest.runOnlyPendingTimers();

		// The edit is on its way to the new room.
		expect( tab.link.queued() ).toBeGreaterThan( 0 );
		expect( tab.blocks()[ 0 ].attributes.content ).toBe( 'One and more' );
	} );
} );

describe( 'provider: two people in one paragraph', () => {
	it( 'brings both editors to the server’s text when both type at the end at once', async () => {
		/*
		 * Two people type at the end of the same paragraph before either
		 * has seen the other. The later burst is set aside for review.
		 * Both editors must end up showing exactly the server's text:
		 * the set-aside text is in a review record, not in the editor.
		 */
		wire = createWireServer( [ roomParagraph( 'p1', 'Alpha' ) ] );

		const alice = await openTab( [ paragraph( 'a-1', 'Alpha', 'p1' ) ] );
		const bob = await openTab( [ paragraph( 'b-1', 'Alpha', 'p1' ) ] );
		const typed = new Map< Tab, { text: string; pushes: number } >();
		const typeBurst = ( tab: Tab, clientId: string, burst: string ) => {
			let text = 'Alpha';

			for ( const letter of burst ) {
				tab.edit(
					[
						{
							type: 'set-attribute',
							clientId,
							attribute: 'content',
							previousValue: text,
							value: text + letter,
						},
					],
					{ isCached: text !== 'Alpha' }
				);
				text += letter;
			}

			typed.set( tab, { text, pushes: tab.pushes.length } );
		};
		// What the editor shows: the last pushed blocks, or the person's
		// own typing when nothing was pushed since.
		const shownText = ( tab: Tab ) => {
			const own = typed.get( tab );

			if ( own && own.pushes === tab.pushes.length ) {
				return own.text;
			}

			return tab.blocks()[ 0 ].attributes.content;
		};

		typeBurst( alice, 'a-1', ' from-A' );
		typeBurst( bob, 'b-1', ' from-B' );

		for ( let round = 0; round < 4; round++ ) {
			alice.sync();
			bob.sync();
		}

		await Promise.resolve();

		expect( serverText( 'p1' ) ).toBe( 'Alpha from-A' );
		expect(
			bob.provider.conflicts.getOpenConflicts( 'postType/post', '1' )
		).not.toHaveLength( 0 );
		expect( shownText( alice ) ).toBe( serverText( 'p1' ) );
		expect( shownText( bob ) ).toBe( serverText( 'p1' ) );
	} );
} );

describe( 'provider: typing that is about to be set aside', () => {
	it( 'leaves the text under the caret alone until the person pauses', async () => {
		/*
		 * Alice is typing when Bob's edit of the same paragraph arrives.
		 * Her tab knows at once that her unanswered letters will be set
		 * aside, before the server says so. Her editor must keep her text
		 * until she pauses, so that the letters she types next go into
		 * the same text, and into the same review record.
		 */
		wire = createWireServer( [ roomParagraph( 'p1', 'Alpha' ) ] );

		let typing = true;
		const alice = await openTab(
			[ paragraph( 'a-1', 'Alpha', 'p1' ) ],
			{},
			{ isTypingIn: ( clientId ) => typing && 'a-1' === clientId }
		);
		const bob = await openTab( [ paragraph( 'b-1', 'Alpha', 'p1' ) ] );
		const pushesBefore = alice.pushes.length;

		bob.type( 'b-1', 'Alpha', 'Bob: Alpha' );
		bob.sync();

		alice.type( 'a-1', 'Alpha', 'Alpha 1' );
		alice.type( 'a-1', 'Alpha 1', 'Alpha 12' );
		alice.sync();

		// Nothing was written to her editor: it still shows "Alpha 12".
		expect( alice.pushes ).toHaveLength( pushesBefore );

		// She types on, in the text her editor shows.
		alice.type( 'a-1', 'Alpha 12', 'Alpha 123' );
		alice.sync();
		alice.sync();
		await Promise.resolve();

		expect( alice.pushes ).toHaveLength( pushesBefore );
		expect( serverText( 'p1' ) ).toBe( 'Bob: Alpha' );

		// All three letters are in one review record, in order.
		const records = alice.provider.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);

		expect( records ).toHaveLength( 1 );
		expect( records[ 0 ].proposed ).toContain( 'Alpha 123' );

		// She pauses, and her editor is brought to the server's text.
		typing = false;
		jest.advanceTimersByTime( 300 );

		expect( alice.blocks()[ 0 ].attributes.content ).toBe( 'Bob: Alpha' );
	} );
} );

describe( 'provider: joining a room that has a history', () => {
	it( 'does not add the saved blocks a second time when a batch arrives early', async () => {
		// Someone added a block earlier. The room's first document is
		// older than that, and the row that added the block arrives right
		// behind it.
		const earlier = await openTab( [ paragraph( 'e-1', 'One', 'p1' ) ] );

		earlier.edit( [
			{
				type: 'insert',
				block: paragraph( 'e-new', 'Added later' ),
				parent: null,
				before: null,
			},
		] );
		earlier.sync();

		const addedId = wire.doc().root.at( -1 )?.syncId ?? '';
		const provider = createIntentLogProvider( context, {
			fetchTaxonomies: async () => [],
		} );
		const before = links.length;

		// The saved post holds all three blocks, with their ids.
		await provider.load(
			'postType',
			'post',
			1,
			{
				blocks: [
					paragraph( 'c-1', 'One', 'p1' ),
					paragraph( 'c-2', 'Two', 'p2' ),
					paragraph( 'c-3', 'Added later', addedId ),
				],
			},
			{
				editRecord: () => {},
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoLevelOpened: () => {},
			}
		);

		// The person types in the newest block before the server answers.
		provider.applyEditBatch( 'postType', 'post', 1, {
			operations: [
				{
					type: 'set-attribute',
					clientId: 'c-3',
					attribute: 'content',
					previousValue: 'Added later',
					value: 'Added later!',
				},
			],
			options: { isCached: false, undoIgnore: false },
		} );

		const { link } = links[ before ];

		link.poll();
		jest.runOnlyPendingTimers();
		link.poll();

		expect( serverOrder() ).toEqual( [ 'p1', 'p2', addedId ] );
		expect( serverText( addedId ) ).toBe( 'Added later!' );
	} );
} );

describe( 'provider: an edit the server refuses because its history is gone', () => {
	it( 'sends the lost edit again instead of dropping it', async () => {
		/*
		 * The server trimmed the history an edit was made against and
		 * refused it without combining it. No newer copy of the room
		 * follows, because the tab is up to date. The text must not
		 * vanish from the person's editor.
		 */
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );
		const { session } = links[ 0 ];
		const sent: string[] = [];

		session.onLocalUpdate( ( update ) => sent.push( update.data ) );
		tab.type( 'c-1', 'One', 'One!!' );

		const first = JSON.parse( sent[ 0 ] );

		session.receiveDispositions?.( [
			{
				intentId: first.intentId,
				status: 'voided',
				reason: 'stale-base',
			},
		] );
		jest.runOnlyPendingTimers();

		expect( sent.length ).toBeGreaterThan( 1 );

		const again = JSON.parse( sent.at( -1 ) ?? '{}' );

		expect( again.intentId ).not.toBe( first.intentId );
		expect( JSON.stringify( again.payload ) ).toContain( '!!' );
	} );

	it( 'sends the lost edit again when a newer copy of the room comes with the refusal', async () => {
		/*
		 * The tab fell behind: the server trimmed history the tab never
		 * received. It refuses the tab's edit and sends a newer copy of
		 * the whole document, which lacks that edit. The text must not
		 * vanish, and the other person's change must show.
		 */
		const tab = await openTab( [
			paragraph( 'c-1', 'One', 'p1' ),
			paragraph( 'c-2', 'Two', 'p2' ),
		] );
		const { session } = links[ 0 ];
		const sent: string[] = [];

		session.onLocalUpdate( ( update ) => sent.push( update.data ) );
		tab.type( 'c-1', 'One', 'One!!' );

		const first = JSON.parse( sent[ 0 ] );

		session.receiveUpdate( {
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
			data: JSON.stringify( {
				doc: createDocument( [
					roomParagraph( 'p1', 'One' ),
					roomParagraph( 'p2', 'Two more' ),
				] ),
				seq: 40,
			} ),
		} );
		session.receiveDispositions?.( [
			{
				intentId: first.intentId,
				status: 'voided',
				reason: 'stale-base',
			},
		] );
		jest.runOnlyPendingTimers();

		const again = JSON.parse( sent.at( -1 ) ?? '{}' );

		expect( again.intentId ).not.toBe( first.intentId );
		expect( again.baseSeq ).toBe( 40 );
		expect( JSON.stringify( again.payload ) ).toContain( '!!' );
		expect( tab.blocks() ).toMatchObject( [
			{ attributes: { content: 'One!!' } },
			{ attributes: { content: 'Two more' } },
		] );
	} );

	it( 'shows a newer copy of the room at once, even while text is being composed', async () => {
		/*
		 * Writes to the editor wait while text is composed. This one may
		 * not: the history between what the editor shows and the newer
		 * copy is gone, so an edit made against the old text could not be
		 * combined with it.
		 */
		let composing = false;
		const tab = await openTab(
			[ paragraph( 'c-1', 'One', 'p1' ) ],
			{},
			{ isComposing: () => composing }
		);
		const { session } = links[ 0 ];

		composing = true;
		session.receiveUpdate( {
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
			data: JSON.stringify( {
				doc: createDocument( [ roomParagraph( 'p1', 'One newer' ) ] ),
				seq: 40,
			} ),
		} );

		expect( tab.blocks() ).toMatchObject( [
			{ attributes: { content: 'One newer' } },
		] );
	} );
} );

describe( 'provider: presence', () => {
	it( 'builds the presence object core-data describes, over a stand-in document', async () => {
		const destroy = jest.fn();
		const created: Array< { clientID: number } > = [];
		const presence = {
			clientID: 0,
			getLocalState: () => ( { collaboratorInfo: { id: 7 } } ),
			setLocalStateField: () => {},
			getStates: () => new Map< number, object >(),
			meta: new Map< number, { clock: number; lastUpdated: number } >(),
			emit: () => {},
			destroy,
		};
		const provider = createIntentLogProvider(
			{
				...context,
				getSyncConfig: () => ( {
					createAwareness: ( doc ) => {
						created.push( doc );

						return presence;
					},
				} ),
			},
			{ fetchTaxonomies: async () => [] }
		);

		await provider.load(
			'postType',
			'post',
			1,
			{},
			{
				editRecord: () => {},
				getEditedRecord: async () => ( {} ),
				refetchRecord: async () => {},
				onUndoLevelOpened: () => {},
			}
		);

		// The stand-in document carries the tab's client id.
		expect( created ).toHaveLength( 1 );
		expect( created[ 0 ].clientID ).toBe( links[ 0 ].session.clientId );
		// The editor's presence display finds the object.
		expect( provider.services?.getAwareness( 'postType/post', '1' ) ).toBe(
			presence
		);
		// This tab's presence goes out with the session's requests.
		expect( links[ 0 ].session.getLocalAwareness() ).toEqual( {
			collaboratorInfo: { id: 7 },
		} );

		provider.unload( 'postType', 'post', 1 );

		expect( destroy ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'provider: saving', () => {
	it( 'sends what the transport holds back before a save', async () => {
		const flushBeforeSave = jest.fn( async () => {} );
		const tab = await openTab(
			[ paragraph( 'c-1', 'One', 'p1' ) ],
			{},
			{ flushBeforeSave }
		);

		await tab.provider.beforeSave?.(
			'postType',
			'post',
			1,
			{},
			{ isAutosave: false }
		);

		expect( flushBeforeSave ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'does not hold an autosave up', async () => {
		const flushBeforeSave = jest.fn( async () => {} );
		const tab = await openTab(
			[ paragraph( 'c-1', 'One', 'p1' ) ],
			{},
			{ flushBeforeSave }
		);

		await tab.provider.beforeSave?.(
			'postType',
			'post',
			1,
			{},
			{ isAutosave: true }
		);

		expect( flushBeforeSave ).not.toHaveBeenCalled();
	} );

	it( 'fails a save when the held edits cannot be sent within five seconds', async () => {
		const tab = await openTab(
			[ paragraph( 'c-1', 'One', 'p1' ) ],
			{},
			{ flushBeforeSave: () => new Promise( () => {} ) }
		);
		const save = tab.provider.beforeSave?.(
			'postType',
			'post',
			1,
			{},
			{ isAutosave: false }
		);
		const failed = expect( save ).rejects.toThrow(
			'Collaboration updates could not be sent'
		);

		await jest.advanceTimersByTimeAsync( 5000 );
		await failed;
	} );

	it( 'waits for the server’s answers, but not for ever', async () => {
		const tab = await openTab( [ paragraph( 'c-1', 'One', 'p1' ) ] );

		// An edit the server never answers.
		tab.type( 'c-1', 'One', 'One!' );

		let saved = false;

		void Promise.resolve(
			tab.provider.beforeSave?.(
				'postType',
				'post',
				1,
				{},
				{ isAutosave: false }
			)
		).then( () => {
			saved = true;
		} );

		await jest.advanceTimersByTimeAsync( 1000 );
		expect( saved ).toBe( false );

		await jest.advanceTimersByTimeAsync( 5000 );
		expect( saved ).toBe( true );
	} );
} );
