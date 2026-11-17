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
import { createDocument } from '../../../src/engines/intent-log/document.js';
import type { BlockSpec } from '../../../src/engines/intent-log/document.js';
// The engine's reference server. One test runs a tab against it to
// reproduce an order of events across two people.
import {
	createServer as rebaseCreateServer,
	serverDocAt as serverDocAtForTest,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import {
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import type {
	EditOperation,
	EntitySyncContext,
	EntitySyncRecord,
	EntitySyncRecordHandlers,
} from '../../../src/editor/gutenberg-contract';
import { createIntentLogProvider } from '../../../src/editor/provider';
import { resetProviderCreatorsForTesting } from '../../../src/registry/transports';
import type {
	EngineSessionCodec,
	EngineUpdate,
	ProviderCreator,
} from '../../../src/registry/types';
import {
	registerConflictSource,
	resetConflictSourcesForTesting,
	resolveConflict as registryResolveConflict,
} from '../../../src/review/conflicts';

/*
 * Review through the provider: the records it publishes for edits the
 * server set aside, and what a reviewer's decision does.
 *
 * These tests hand the session its rows directly, so each one can state
 * exactly which edits were set aside and in which order rows arrive.
 *
 * The stand-in for the blocks package writes and reads blocks as JSON,
 * and knows no block type.
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
		getBlockContent: ( block: { innerContent?: Array< string | null > } ) =>
			( block.innerContent ?? [] )
				.filter( ( piece ) => 'string' === typeof piece )
				.join( '' ),
		getSaveContent: () => '',
		serialize: ( blocks: Array< Parameters< typeof strip >[ 0 ] > ) =>
			JSON.stringify( blocks.map( strip ) ),
		serializeRawBlock: ( block: {
			blockName: string;
			innerContent: string[];
		} ) =>
			JSON.stringify( [
				{
					name: block.blockName,
					markup: block.innerContent.join( '' ).trim(),
				},
			] ),
		parse: ( content: string ) => ( content ? JSON.parse( content ) : [] ),
	};
} );

/**
 * A stand-in transport that keeps the session it was given and the
 * updates the session wants to send.
 *
 * @return The transport and what it captured.
 */
function makeFakeTransport() {
	const captured: {
		session?: EngineSessionCodec;
		sent: EngineUpdate[];
	} = { sent: [] };

	const creator: ProviderCreator = async ( options ) => {
		const { session } = options;

		session.onLocalUpdate( ( update ) => captured.sent.push( update ) );
		captured.session = {
			...session,
			receiveUpdate: ( update ) => {
				const answer = session.receiveUpdate( update );

				// The provider matches the editor's blocks one task after
				// the first document. Run that task here, so a test can go
				// on in one line.
				if ( INTENT_LOG_UPDATE_TYPES.SNAPSHOT === update.type ) {
					jest.runOnlyPendingTimers();
				}

				return answer;
			},
		};

		return { destroy: () => {}, on: () => {} };
	};

	return { captured, creator };
}

const snapshotRow = (
	blocks: BlockSpec[],
	props: Record< string, unknown > = {}
) => ( {
	data: JSON.stringify( { doc: createDocument( blocks, props ) } ),
	type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
} );

/**
 * A row for an edit the server set aside for review.
 *
 * @param intent  The edit.
 * @param actorId Its author.
 * @param reason  Why it was set aside.
 * @return The row.
 */
const parkedRow = (
	intent: Record< string, unknown >,
	actorId: string,
	reason = 'frame-conflict'
) => ( {
	data: JSON.stringify( { intent, actorId, reason } ),
	type: INTENT_LOG_UPDATE_TYPES.PARKED,
} );

/**
 * The paragraph texts of one side of a record.
 *
 * @param side The side, as saved blocks.
 * @return The texts.
 */
const textOf = ( side: string | null ) =>
	JSON.parse( side ?? '[]' ).map(
		( block: { attributes: { content: string } } ) =>
			block.attributes.content
	);

/** Lets the review notice that is sent after a burst of rows go out. */
const settle = async () => {
	await Promise.resolve();
	jest.runOnlyPendingTimers();
	await Promise.resolve();
};

const FILTER = 'sync.providers';
const HOOK = 'wp-real-time-collaboration/provider-review-test';

const context: EntitySyncContext = {
	getSyncConfig: () => ( {} ),
	recordHandlers: () => ( { onStatusChange: () => {} } ),
	collectionHandlers: () => ( { onStatusChange: () => {} } ),
};

describe( 'provider: review records and decisions', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		(
			window as { __experimentalEnableRealTimeCollaboration?: boolean }
		 ).__experimentalEnableRealTimeCollaboration = true;
	} );

	afterEach( () => {
		jest.clearAllTimers();
		jest.useRealTimers();
		removeFilter( FILTER, HOOK );
		resetConflictSourcesForTesting();
		resetProviderCreatorsForTesting();
	} );

	/**
	 * Opens post 1 in a tab.
	 *
	 * @param record The record the editor loaded.
	 * @return The provider under the names the tests use, the editor's
	 *         handlers, and the transport.
	 */
	async function loadManagedEntity( record: EntitySyncRecord = {} ) {
		const transport = makeFakeTransport();

		addFilter( FILTER, HOOK, () => [ transport.creator ] );

		const provider = createIntentLogProvider( context, {
			fetchTaxonomies: async () => [],
			flushBeforeSave: async () => {},
		} );
		const edits: EntitySyncRecord[] = [];
		const handlers: EntitySyncRecordHandlers & {
			edits: EntitySyncRecord[];
		} = {
			edits,
			editRecord: ( data ) => {
				edits.push( data );
			},
			getEditedRecord: async () => ( {} ),
			refetchRecord: async () => {},
			onUndoLevelOpened: () => {},
		};

		await provider.load( 'postType', 'post', 1, record, handlers );

		const manager = {
			conflicts: provider.conflicts,
			restoreProposal: (
				_objectType: string,
				_objectId: string,
				proposalId: string
			) => provider.restoreProposal( 'postType', 'post', 1, proposalId ),
			// Sends one batch of operations, as core-data would.
			edit: ( operations: EditOperation[] ) =>
				provider.applyEditBatch( 'postType', 'post', 1, {
					operations,
					options: { isCached: false, undoIgnore: false },
				} ),
		};

		return { manager, handlers, transport };
	}

	it( 'publishes parked proposals as conflict records with kind and author', async () => {
		const { manager, transport } = await loadManagedEntity();
		const changed = jest.fn();
		const unsubscribe = manager.conflicts.subscribe(
			'postType/post',
			'1',
			changed
		);

		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		const proposalRow = ( actorId: string, reason: string ) => ( {
			data: JSON.stringify( {
				intent: {
					intentId: `i-${ reason }`,
					txnId: null,
					type: 'insert_text',
					payload: { text: 'lost words' },
				},
				actorId,
				reason,
				context: { excerpt: 'Around here' },
			} ),
			type: INTENT_LOG_UPDATE_TYPES.PARKED,
		} );

		transport.captured.session!.receiveUpdate(
			proposalRow( 'u999c999', 'frame-conflict' )
		);
		// Listeners hear about the settled open list one microtask later.
		await settle();
		expect( changed ).toHaveBeenCalledTimes( 1 );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'i-frame-conflict',
				kind: 'merge',
				authorId: 999,
			} ),
		] );

		// A security hold is a sequestration record.
		transport.captured.session!.receiveUpdate(
			proposalRow( 'u5c5', 'requires-approval' )
		);
		await settle();
		expect( changed ).toHaveBeenCalledTimes( 2 );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( { id: 'i-frame-conflict' } ),
			expect.objectContaining( {
				id: 'i-requires-approval',
				kind: 'sequestration',
				authorId: 5,
			} ),
		] );
		unsubscribe();
	} );

	it( 'conflict records carry the target block identity and position when the intent addresses one', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'block-0', blockType: 'core/paragraph', text: 'A' },
				{ syncId: 'block-a', blockType: 'core/paragraph', text: 'B' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-anchored',
					txnId: null,
					type: 'insert_text',
					payload: { syncId: 'block-a', text: 'lost' },
				},
				'u9c9'
			)
		);
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'p-anchored',
				target: {
					type: 'blocks',
					ids: [ 'block-a' ],
					parentId: undefined,
					index: 1,
					count: 1,
				},
			} ),
		] );

		// Document-level intents (entity properties) target the property.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-property',
					txnId: null,
					type: 'set_property',
					payload: { name: 'title', value: 'Lost title' },
				},
				'u9c9',
				'property-conflict'
			)
		);
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( { id: 'p-anchored' } ),
			expect.objectContaining( {
				id: 'p-property',
				target: { type: 'property', name: 'title' },
			} ),
		] );
	} );

	it( 'a parked insert_block proposal targets the position after its anchor sibling', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Anchor',
				},
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'ins-1',
					txnId: null,
					type: 'insert_block',
					payload: {
						block: {
							syncId: 'nb',
							blockType: 'core/html',
							fields: {
								content: {
									text: '￼',
									formats: [
										{
											start: 0,
											end: 1,
											format: 'obj|{"html":"<script>x</script>"}',
										},
									],
								},
							},
						},
						parentId: null,
						afterSiblingId: 'p1',
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await settle();

		// An insertion targets the slot after 'p1' with a count of 0 (no
		// block exists yet), and its summary carries the DECODED markup
		// (not the object-replacement char).
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'ins-1',
				kind: 'sequestration',
				target: {
					type: 'blocks',
					parentId: undefined,
					index: 1,
					count: 0,
				},
				proposed: expect.stringContaining( '<script>x</script>' ),
			} ),
		] );
	} );

	it( 'a proposal resolved within the same delivery batch never opens, and a decision round-trips', async () => {
		const { manager, transport } = await loadManagedEntity();
		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );

		transport.captured.session!.receiveUpdate( snapshotRow( [] ) );

		// Bootstrap replay shape: parked row immediately followed by its
		// resolution row (a long-resolved conflict).
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'old-1',
					txnId: null,
					type: 'insert_text',
					payload: { text: 'ancient' },
				},
				'u9c9'
			)
		);
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				proposalId: 'old-1',
				resolution: 'dismissed',
			} ),
			type: INTENT_LOG_UPDATE_TYPES.RESOLVED,
		} );
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );

		// A live open proposal opens a record. Dismissing it emits the
		// wire row and empties the list.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'live-1',
					txnId: null,
					type: 'insert_text',
					payload: { text: 'fresh' },
				},
				'u9c9'
			)
		);
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );

		manager.conflicts.resolveConflict( 'postType/post', '1', 'live-1', {
			action: 'dismiss',
		} );
		const resolvedRows = transport.captured.sent.filter(
			( update ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === update.type
		);
		expect( resolvedRows ).toHaveLength( 1 );
		expect( JSON.parse( resolvedRows[ 0 ].data ) ).toEqual( {
			proposalId: 'live-1',
			resolution: 'dismissed',
		} );
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a parked text edit carries its base, proposed, and current sides', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		// A collaborator's edit landed first...
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 5,
					text: ' there',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		// ...and another author's edit against the same base parked.
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await settle();

		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( conflict ).toMatchObject( {
			id: 'parked-1',
			kind: 'merge',
			authorId: 8,
			target: { type: 'blocks', ids: [ 'p1' ], index: 0, count: 1 },
		} );
		expect( textOf( conflict.base ) ).toEqual( [ 'Hello' ] );
		expect( textOf( conflict.proposed ) ).toEqual( [ 'Hello friend' ] );
		expect( textOf( conflict.current ) ).toEqual( [ 'Hello there' ] );
	} );

	it( "publishes a record again when a collaborator's edit changes its current side, and refuses a decision made against the older one", async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await settle();

		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );
		// The reviewer opens the dialog on this record.
		const [ seen ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( textOf( seen.current ) ).toEqual( [ 'Hello' ] );

		// A collaborator edits the block while the dialog is open. No
		// proposal opens or closes.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p1',
					field: 'content',
					offset: 5,
					text: ' there',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		await settle();

		// The listeners hear about it, and the record shows the edit.
		expect( changed ).toHaveBeenCalledTimes( 1 );
		const [ fresh ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( textOf( fresh.current ) ).toEqual( [ 'Hello there' ] );

		// A decision made against the older current side is refused:
		// nothing is sent, and the record stays open.
		transport.captured.sent.length = 0;
		const replacement = JSON.stringify( [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello friend',
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
			},
		] );
		// The refusal is the conflict registry's, against the record the
		// engine publishes; the engine is never asked.
		registerConflictSource( manager.conflicts );
		await expect(
			registryResolveConflict( 'postType/post', '1', seen.id, {
				action: 'accept',
				content: replacement,
				current: seen.current,
			} )
		).resolves.toBe( 'stale' );
		expect( transport.captured.sent ).toEqual( [] );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toHaveLength( 1 );

		// The same decision against the current side as it is now goes
		// through.
		expect(
			manager.conflicts.resolveConflict( 'postType/post', '1', fresh.id, {
				action: 'accept',
				content: replacement,
				current: fresh.current,
			} )
		).toBe( 'resolved' );
		expect(
			transport.captured.sent.some(
				( update ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === update.type
			)
		).toBe( true );
	} );

	it( 'says nothing when a document change leaves every record as it was', async () => {
		const { manager, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Other' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 5,
						text: ' friend',
					},
				},
				'u8c8'
			)
		);
		await settle();
		const changed = jest.fn();
		manager.conflicts.subscribe( 'postType/post', '1', changed );
		manager.conflicts.getOpenConflicts( 'postType/post', '1' );

		// An edit to ANOTHER block: the record reads the same.
		transport.captured.session!.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'insert_text',
				payload: {
					syncId: 'p2',
					field: 'content',
					offset: 5,
					text: ' words',
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		await settle();

		expect( changed ).not.toHaveBeenCalled();
	} );

	it( 'accept authors the replacement as ordinary intents, then closes every member, in that order', async () => {
		const { manager, handlers, transport } = await loadManagedEntity();

		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Hello' },
			] )
		);
		// Two parked keystrokes on the same block: one record.
		for ( const [ intentId, offset, text ] of [
			[ 'k1', 5, '!' ],
			[ 'k2', 6, '?' ],
		] as Array< [ string, number, string ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: null,
						type: 'insert_text',
						payload: {
							syncId: 'p1',
							field: 'content',
							offset,
							text,
						},
					},
					'u8c8'
				)
			);
		}
		await settle();
		const open = manager.conflicts.getOpenConflicts( 'postType/post', '1' );
		expect( open ).toHaveLength( 1 );
		transport.captured.sent.length = 0;

		// The reviewer's merged result keeps the block's identity.
		const replacement = JSON.stringify( [
			{
				name: 'core/paragraph',
				attributes: {
					content: 'Hello, merged',
					metadata: { syncId: 'p1' },
				},
				innerBlocks: [],
			},
		] );
		handlers.edits.length = 0;
		manager.conflicts.resolveConflict( 'postType/post', '1', open[ 0 ].id, {
			action: 'accept',
			content: replacement,
		} );

		// The canvas shows the decision at once, not a poll later.
		const pushed = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: Record< string, unknown > } >;
		};
		expect( pushed.blocks[ 0 ].attributes.content ).toBe( 'Hello, merged' );

		const sent = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const firstResolution = sent.findIndex(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		const intents = sent.filter(
			( row ) => INTENT_LOG_UPDATE_TYPES.INTENT === row.type
		);
		// The replacement is an ordinary edit of the SAME block, under one
		// txn, and every intent precedes every resolution.
		expect( intents.length ).toBeGreaterThan( 0 );
		expect(
			intents.every( ( row ) => 'p1' === row.decoded.payload.syncId )
		).toBe( true );
		expect(
			new Set( intents.map( ( row ) => row.decoded.txnId ) ).size
		).toBe( 1 );
		expect( intents[ 0 ].decoded.txnId ).toEqual( expect.any( String ) );
		expect( firstResolution ).toBe( intents.length );
		expect(
			sent.slice( firstResolution ).map( ( row ) => row.decoded )
		).toEqual( [
			{ proposalId: 'k1', resolution: 'dismissed' },
			{ proposalId: 'k2', resolution: 'dismissed' },
		] );

		// The document holds the merged text, and the record is closed.
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root[ 0 ].fields.content.text ).toBe( 'Hello, merged' );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a record over two blocks that are not neighbours shows the block between them, and accept keeps the order', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
				{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
			] )
		);
		// One edit by another author changed the first and the third
		// paragraph, and was set aside.
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await settle();

		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		// This record's sides hold several serialized runs.
		const textOfRuns = ( side: string | null ) =>
			JSON.parse( `[${ ( side ?? '' ).split( '\n\n' ).join( ',' ) }]` )
				.flat()
				.map(
					( block: { attributes: { content: string } } ) =>
						block.attributes.content
				);
		expect( conflict.target ).toMatchObject( {
			type: 'blocks',
			ids: [ 'p1', 'p2', 'p3' ],
			index: 0,
			count: 3,
		} );
		expect( textOfRuns( conflict.current ) ).toEqual( [
			'One',
			'Two',
			'Three',
		] );
		expect( textOfRuns( conflict.proposed ) ).toEqual( [
			'One!',
			'Two',
			'Three!',
		] );

		// The reviewer accepts a merged result of all three blocks.
		const merged = ( syncId: string, content: string ) => ( {
			name: 'core/paragraph',
			attributes: { content, metadata: { syncId } },
			innerBlocks: [],
		} );
		const outcome = manager.conflicts.resolveConflict(
			'postType/post',
			'1',
			conflict.id,
			{
				action: 'accept',
				content: JSON.stringify( [
					merged( 'p1', 'One, merged' ),
					merged( 'p2', 'Two' ),
					merged( 'p3', 'Three, merged' ),
				] ),
				current: conflict.current,
			}
		);
		expect( outcome ).toBe( 'resolved' );

		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect(
			doc.root.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p1:One, merged', 'p2:Two', 'p3:Three, merged' ] );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'a record over a block and a block inside a group covers the group, and accept keeps the inner block in it', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{
					syncId: 'g',
					blockType: 'core/group',
					children: [
						{
							syncId: 'p3',
							blockType: 'core/paragraph',
							text: 'Three',
						},
					],
				},
			] )
		);
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await settle();
		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);
		expect( conflict.target ).toMatchObject( {
			ids: [ 'p1', 'g' ],
			index: 0,
			count: 2,
		} );

		// The reviewer takes the proposed side as it is. (The stand-in
		// parser reads one JSON list, the sides are one list per block.)
		const proposed = JSON.stringify(
			conflict.proposed
				.split( '\n\n' )
				.flatMap( ( block ) => JSON.parse( block ) )
		);
		manager.conflicts.resolveConflict( 'postType/post', '1', conflict.id, {
			action: 'accept',
			content: proposed,
		} );

		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root.map( ( block ) => block.syncId ) ).toEqual( [
			'p1',
			'g',
		] );
		expect( doc.root[ 0 ].fields.content.text ).toBe( 'One!' );
		expect(
			doc.root[ 1 ].children.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p3:Three!' ] );
	} );

	it( 'an accepted result may leave out a block from between the two blocks, because the reviewer saw it', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'One' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Two' },
				{ syncId: 'p3', blockType: 'core/paragraph', text: 'Three' },
				{ syncId: 'p4', blockType: 'core/paragraph', text: 'Four' },
			] )
		);
		for ( const [ intentId, syncId, offset ] of [
			[ 'm1', 'p1', 3 ],
			[ 'm2', 'p3', 5 ],
		] as Array< [ string, string, number ] > ) {
			transport.captured.session!.receiveUpdate(
				parkedRow(
					{
						intentId,
						actorId: 'u8c8',
						baseSeq: 0,
						txnId: 'txn-ends',
						type: 'insert_text',
						payload: {
							syncId,
							field: 'content',
							offset,
							text: '!',
						},
					},
					'u8c8'
				)
			);
		}
		await settle();
		const [ conflict ] = manager.conflicts.getOpenConflicts(
			'postType/post',
			'1'
		);

		manager.conflicts.resolveConflict( 'postType/post', '1', conflict.id, {
			action: 'accept',
			content: JSON.stringify( [
				{
					name: 'core/paragraph',
					attributes: {
						content: 'One and three',
						metadata: { syncId: 'p1' },
					},
					innerBlocks: [],
				},
			] ),
		} );

		// The run is replaced as one piece. The block after it stays.
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect(
			doc.root.map(
				( block ) => `${ block.syncId }:${ block.fields.content.text }`
			)
		).toEqual( [ 'p1:One and three', 'p4:Four' ] );
	} );

	it( "accept with empty content removes the record's block", async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{ syncId: 'p1', blockType: 'core/paragraph', text: 'Keep' },
				{ syncId: 'p2', blockType: 'core/paragraph', text: 'Drop' },
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-1',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p2',
						field: 'content',
						offset: 4,
						text: '!',
					},
				},
				'u8c8'
			)
		);
		await settle();

		manager.conflicts.resolveConflict( 'postType/post', '1', 'parked-1', {
			action: 'accept',
			content: '',
		} );
		const doc = (
			transport.captured.session as IntentLogSession
		 ).getDocument()!;
		expect( doc.root.map( ( block ) => block.syncId ) ).toEqual( [ 'p1' ] );
	} );

	it( "REGRESSION: accepting the split version of the reviewer's OWN parked split keeps both halves", async () => {
		// Manual finding: user B split "This block is too long. It
		// should be split…" at the period while user A typed into the
		// same paragraph. B's split was set aside; the record's proposed
		// side showed both halves. B chose that version and accepted,
		// and only the first half remained. The parked split had left
		// B's optimistic document, so the second half's id was
		// tombstoned, and the accept path's stale-tree filter dropped
		// the block the reviewer had just chosen to put back.
		const paragraph = {
			syncId: 'p1',
			blockType: 'core/paragraph',
			text: 'This block is too long. It should be split into multiple paragraphs.',
		};
		const head = 'This block is too long.';
		const tail = ' It should be split into multiple paragraphs.';
		const server = rebaseCreateServer(
			createDocument( [ paragraph ] )
		) as unknown as {
			log: Array< Record< string, unknown > >;
			proposals: Array< Record< string, unknown > >;
		};
		const ingest = ( rows: Parameters< typeof serverIngestBatch >[ 1 ] ) =>
			serverIngestBatch( server as never, rows ) as Array< {
				status: string;
				reason?: string;
			} >;
		const takeSent = () =>
			transport.captured.sent
				.splice( 0 )
				.filter(
					( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
				)
				.map( ( update ) => JSON.parse( update.data ) );
		const { manager, handlers, transport } = await loadManagedEntity();
		const session = transport.captured.session as IntentLogSession;
		session.receiveUpdate( snapshotRow( [ paragraph ] ) );
		const lastPush = () =>
			handlers.edits.at( -1 ) as {
				blocks: Array< {
					clientId: string;
					attributes: { content: string };
				} >;
			};
		const clientId = lastPush().blocks[ 0 ].clientId;

		// B types into the paragraph, then presses Enter after the
		// period: the text gets shorter and a new block holds the rest.
		manager.edit( [
			{
				type: 'set-attribute',
				clientId,
				attribute: 'content',
				previousValue: paragraph.text,
				value: `Yes, ${ paragraph.text }`,
			},
		] );
		manager.edit( [
			{
				type: 'set-attribute',
				clientId,
				attribute: 'content',
				previousValue: `Yes, ${ paragraph.text }`,
				value: `Yes, ${ head }`,
			},
			{
				type: 'insert',
				block: {
					clientId: 'editor-tail',
					name: 'core/paragraph',
					attributes: { content: tail },
					innerBlocks: [],
				},
				parent: null,
				before: null,
			},
		] );
		jest.runOnlyPendingTimers();
		const burst = takeSent();
		expect( burst.map( ( row ) => row.type ) ).toEqual( [
			'insert_text',
			'split_block',
		] );
		const tailId = burst[ 1 ].payload.newSyncId as string;
		expect( session.getDocument()!.root.map( ( b ) => b.syncId ) ).toEqual(
			[ 'p1', tailId ]
		);

		// A's keystroke into the same paragraph reaches the server
		// first, and B's burst, planned against the older frame, is set
		// aside whole (rule 5).
		expect(
			ingest( [
				{
					intentId: 'a-1',
					actorId: 'u9c9',
					baseSeq: 0,
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'I think ',
					},
				},
			] ).map( ( d ) => d.status )
		).toEqual( [ 'applied' ] );
		const dispositions = ingest( burst );
		expect( dispositions.map( ( d ) => d.reason ) ).toEqual( [
			'frame-conflict',
			'dependent-on-escalated',
		] );
		// One poll: the accepted row, the parked rows, the acks.
		session.receiveUpdate( {
			data: JSON.stringify( server.log[ 0 ] ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		for ( const proposal of server.proposals ) {
			session.receiveUpdate( {
				data: JSON.stringify( proposal ),
				type: INTENT_LOG_UPDATE_TYPES.PARKED,
			} );
		}
		session.receiveDispositions!(
			dispositions.map( ( disposition, index ) => ( {
				...disposition,
				intentId: burst[ index ].intentId as string,
			} ) ) as never
		);
		await settle();
		// B's optimistic document no longer shows the split.
		expect(
			session
				.getDocument()!
				.root.map( ( b ) => `${ b.syncId }:${ b.fields.content.text }` )
		).toEqual( [ `p1:I think ${ paragraph.text }` ] );
		const open = manager.conflicts.getOpenConflicts( 'postType/post', '1' );
		expect( open ).toHaveLength( 1 );
		// The side is one serialized chunk per block (the test's serialize
		// is JSON, so re-join the chunks into one block list).
		const proposedBlocks = JSON.parse(
			`[${ open[ 0 ].proposed.split( '\n\n' ).join( ',' ) }]`
		).flat() as Array< {
			attributes: { content: string; metadata?: { syncId?: string } };
		} >;
		expect( proposedBlocks.map( ( b ) => b.attributes.content ) ).toEqual( [
			`Yes, ${ head }`,
			tail,
		] );
		expect( proposedBlocks[ 1 ].attributes.metadata?.syncId ).toBe(
			tailId
		);

		// B restores "Your version" (the proposed side) and accepts.
		handlers.edits.length = 0;
		manager.conflicts.resolveConflict( 'postType/post', '1', open[ 0 ].id, {
			action: 'accept',
			content: JSON.stringify( proposedBlocks ),
			current: open[ 0 ].current,
		} );

		const bothHalves = [ `Yes, ${ head }`, tail ];
		expect(
			session.getDocument()!.root.map( ( b ) => b.fields.content.text )
		).toEqual( bothHalves );
		expect(
			lastPush().blocks.map( ( b ) => b.attributes.content )
		).toEqual( bothHalves );
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );

		// The server takes the accepted result as it was authored.
		const acceptBatch = takeSent();
		expect( acceptBatch.length ).toBeGreaterThan( 0 );
		expect( ingest( acceptBatch ).map( ( d ) => d.status ) ).toEqual(
			acceptBatch.map( () => 'applied' )
		);
		const serverHead = serverDocAtForTest(
			server as never,
			server.log.length
		);
		expect( serverHead.root.map( ( b ) => b.fields.content.text ) ).toEqual(
			bothHalves
		);
	} );

	it( 'accept of a post-field record authors one set_property at the observed version, then closes the record', async () => {
		const { manager, handlers, transport } = await loadManagedEntity( {
			title: { raw: 'Original' },
		} );
		const session = transport.captured.session as IntentLogSession;
		session.receiveUpdate( snapshotRow( [], { title: 'Original' } ) );
		// A collaborator's title landed first...
		session.receiveUpdate( {
			data: JSON.stringify( {
				intentId: 'remote-title-1',
				actorId: 'u9c9',
				baseSeq: 0,
				txnId: null,
				type: 'set_property',
				payload: {
					name: 'title',
					value: 'Winning title',
					observedVersion: 0,
				},
			} ),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );
		// ...and another author's title against the same base parked.
		session.receiveUpdate(
			parkedRow(
				{
					intentId: 'p-title',
					actorId: 'u8c8',
					baseSeq: 0,
					txnId: null,
					type: 'set_property',
					payload: {
						name: 'title',
						value: 'Set-aside title',
						observedVersion: 0,
					},
				},
				'u8c8',
				'property-conflict'
			)
		);
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [
			expect.objectContaining( {
				id: 'p-title',
				target: { type: 'property', name: 'title' },
			} ),
		] );
		const observedVersion = session.getDocument()!.propVersions!.title;
		expect( observedVersion ).toBeGreaterThan( 0 );
		transport.captured.sent.length = 0;

		manager.conflicts.resolveConflict( 'postType/post', '1', 'p-title', {
			action: 'accept',
			content: 'Merged title',
		} );

		// One property write that has seen the current title, then the
		// closure behind it.
		const sent = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		expect( sent ).toEqual( [
			{
				type: INTENT_LOG_UPDATE_TYPES.INTENT,
				decoded: expect.objectContaining( {
					type: 'set_property',
					payload: {
						name: 'title',
						value: 'Merged title',
						observedVersion,
					},
				} ),
			},
			{
				type: INTENT_LOG_UPDATE_TYPES.RESOLVED,
				decoded: { proposalId: 'p-title', resolution: 'dismissed' },
			},
		] );

		// The document and the reviewer's editor hold the accepted title,
		// and the record is closed.
		expect( session.getDocument()!.props!.title ).toBe( 'Merged title' );
		expect( handlers.edits.at( -1 ) ).toEqual( { title: 'Merged title' } );
		await settle();
		expect(
			manager.conflicts.getOpenConflicts( 'postType/post', '1' )
		).toEqual( [] );
	} );

	it( 'restoreProposal re-authors lost text at the current head, then resolves', async () => {
		const { manager, handlers, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Existing text',
				},
			] )
		);
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'lost-1',
					txnId: null,
					type: 'insert_text',
					payload: {
						syncId: 'p1',
						field: 'content',
						offset: 4,
						text: ' recovered',
					},
				},
				'u9c9'
			)
		);
		await settle();

		manager.restoreProposal( 'postType/post', '1', 'lost-1' );

		// The recovered text was authored as an ORDINARY intent at the end
		// of the target field, and the proposal closed as restored.
		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'insert_text' === row.decoded.type
		);
		expect( authored!.decoded.payload ).toMatchObject( {
			syncId: 'p1',
			field: 'content',
			offset: 'Existing text'.length,
			text: ' recovered',
		} );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'lost-1',
			resolution: 'restored',
		} );
		// The restored content reached the editor push path.
		const lastBlocks = handlers.edits.at( -1 ) as {
			blocks: Array< { attributes: { content: string } } >;
		};
		expect( lastBlocks.blocks[ 0 ].attributes.content ).toBe(
			'Existing text recovered'
		);
	} );

	it( 'restoreProposal re-inserts a parked block under fresh identity, then resolves', async () => {
		const { manager, transport } = await loadManagedEntity();
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'p1',
					blockType: 'core/paragraph',
					text: 'Existing text',
				},
			] )
		);
		// A requires-approval park of a raw-attr block (core/html shape).
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-html',
					txnId: null,
					type: 'insert_block',
					payload: {
						block: {
							syncId: 'nb-original',
							blockType: 'core/html',
							attrs: { content: '<script>x</script>' },
						},
						parentId: null,
						afterSiblingId: 'gone-sibling',
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await settle();

		manager.restoreProposal( 'postType/post', '1', 'parked-html' );

		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'insert_block' === row.decoded.type
		);
		// Re-authored under a FRESH identity (the original never applied),
		// same spec content, degraded anchor (vanished sibling → end).
		expect( authored ).toBeDefined();
		expect( authored!.decoded.payload.block.blockType ).toBe( 'core/html' );
		expect( authored!.decoded.payload.block.attrs ).toEqual( {
			content: '<script>x</script>',
		} );
		expect( authored!.decoded.payload.block.syncId ).not.toBe(
			'nb-original'
		);
		expect( authored!.decoded.payload.afterSiblingId ).toBe( 'p1' );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'parked-html',
			resolution: 'restored',
		} );
	} );

	it( 'restoreProposal re-authors a parked format application, then resolves', async () => {
		const { manager, transport } = await loadManagedEntity();
		// The kses lane's shape for a custom HTML block content change: the
		// placeholder character landed as safe plain text, and only the
		// format carrying the markup parked.
		transport.captured.session!.receiveUpdate(
			snapshotRow( [
				{
					syncId: 'h1',
					blockType: 'core/html',
					text: '￼',
				},
			] )
		);
		const format = 'obj|{"html":"<script>alert(0);</script>"}';
		transport.captured.session!.receiveUpdate(
			parkedRow(
				{
					intentId: 'parked-format',
					txnId: null,
					type: 'format_text',
					payload: {
						syncId: 'h1',
						field: 'content',
						start: 0,
						end: 1,
						format,
						on: true,
					},
				},
				'u9c9',
				'requires-approval'
			)
		);
		await settle();

		manager.restoreProposal( 'postType/post', '1', 'parked-format' );

		// The format re-applies over the surviving placeholder as an
		// ORDINARY intent (carrying the restorer's capability), and the
		// proposal closes as restored.
		const sentTypes = transport.captured.sent.map( ( update ) => ( {
			type: update.type,
			decoded: JSON.parse( update.data ),
		} ) );
		const authored = sentTypes.find(
			( row ) =>
				INTENT_LOG_UPDATE_TYPES.INTENT === row.type &&
				'format_text' === row.decoded.type
		);
		expect( authored ).toBeDefined();
		expect( authored!.decoded.payload ).toMatchObject( {
			syncId: 'h1',
			field: 'content',
			start: 0,
			end: 1,
			format,
			on: true,
		} );
		const resolved = sentTypes.find(
			( row ) => INTENT_LOG_UPDATE_TYPES.RESOLVED === row.type
		);
		expect( resolved!.decoded ).toEqual( {
			proposalId: 'parked-format',
			resolution: 'restored',
		} );
	} );
} );
