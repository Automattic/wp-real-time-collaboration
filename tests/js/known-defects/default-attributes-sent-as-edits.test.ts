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
import type {
	EngineSessionCodec,
	EngineUpdate,
	ProviderCreator,
	RecordHandlers,
	SyncConfig,
} from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { createIntentLogManager } from '../../../src/engines/intent-log-manager';
import type { BridgeBlock } from '../../../src/engines/intent-log-bridge';
import { INTENT_LOG_UPDATE_TYPES } from '../../../src/engines/intent-log-session';
import {
	resetEngineAdaptersForTesting,
	resetProviderCreatorsForTesting,
} from '../../../src/framework';
import { resetConflictSourcesForTesting } from '../../../src/review/conflicts';
import { createDocument } from '../../../src/engines/intent-log/document.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type {
	IntentEnvelope,
	IntentLogServer,
} from '../../../src/engines/intent-log/engine-types';
import { contentText } from './helpers';

/*
 * Known defect. This is why the two-person host benchmark
 * (`npm run bench -- --peers=2`) fails.
 *
 * The server builds its first copy of a post from the block comments in
 * the saved content. Those comments leave out values that equal the
 * block's default, such as `dropCap: false` on a paragraph. The editor's
 * blocks always carry those values. The first time a tab captures an
 * edit, it compares the whole editor tree with the document, so it sends
 * "set dropCap to false" for every paragraph in the post, next to the
 * text the person typed.
 *
 * One tab doing this is harmless. When two tabs make their first edit
 * before either has seen the other's, both send the same attribute
 * writes for every block. The server sets the second tab's writes aside
 * as conflicts, and a review card covers each paragraph, including the
 * paragraph the person is typing in. In the benchmark the two writers
 * type their first word 203 ms apart, each in their own paragraph.
 */

// The block registry, reduced to what the engine reads. The paragraph
// type has the same default as the real one, and its saved markup has the
// same wrapper.
jest.mock( '@wordpress/blocks', () => {
	interface MockBlock {
		name: string;
		attributes: Record< string, unknown >;
		innerBlocks?: MockBlock[];
	}
	const strip = ( block: MockBlock ): MockBlock => ( {
		name: block.name,
		attributes: block.attributes,
		innerBlocks: ( block.innerBlocks ?? [] ).map( strip ),
	} );

	return {
		getBlockType: ( name: string ) => {
			if ( 'core/paragraph' !== name ) {
				return undefined;
			}

			return {
				attributes: { dropCap: { type: 'boolean', default: false } },
			};
		},
		getSaveContent: (
			_blockType: object,
			attributes: Record< string, unknown >
		) => `<p>${ String( attributes.content ?? '' ) }</p>`,
		serialize: ( blocks: MockBlock[] ) =>
			JSON.stringify( blocks.map( strip ) ),
		serializeRawBlock: () => '',
		parse: ( content: string ) => {
			if ( ! content ) {
				return [];
			}

			return JSON.parse( content );
		},
	};
} );

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn( () => Promise.resolve( {} ) ),
} ) );

const FILTER = 'sync.providers';
const HOOK = 'test/known-defects';
const POST: [ string, string ] = [ 'postType/post', '1' ];
const ANCHORS = [ 'hostw0anchor', 'hostw1anchor' ];

const SYNC_CONFIG: SyncConfig = {
	applyChangesToCRDTDoc: () => {},
	getChangesFromCRDTDoc: () => ( {} ),
};

/**
 * The server's first copy of the benchmark post: one paragraph per
 * writer, with the wrapper markup the server records and no default
 * values.
 *
 * @return The document.
 */
function firstServerCopy() {
	return createDocument(
		ANCHORS.map( ( text, index ) => ( {
			syncId: `g${ index }`,
			blockType: 'core/paragraph',
			attrs: { _wrapper: { open: '<p>', close: '</p>' } },
			text,
		} ) )
	);
}

/**
 * A stand-in for one person's editor tab: the real engine manager, a
 * block tree that takes what the manager pushes, and a transport that
 * talks to the shared server only when poll() is called.
 *
 * @param server The shared server.
 * @param anchor The text that marks this person's own paragraph.
 * @return The tab.
 */
async function openTab( server: IntentLogServer, anchor: string ) {
	const unsent: EngineUpdate[] = [];
	const sentRows: IntentEnvelope[] = [];
	let session: EngineSessionCodec | null = null;
	let rowsSeen = 0;
	let setAsideSeen = 0;

	// The post as the editor parses it: default values filled in.
	let blocks: BridgeBlock[] = ANCHORS.map( ( content, index ) => ( {
		clientId: `${ anchor }-${ index }`,
		name: 'core/paragraph',
		attributes: { content, dropCap: false },
		innerBlocks: [],
	} ) );

	const isBlockList = ( value: unknown ): value is BridgeBlock[] =>
		Array.isArray( value );

	const handlers: RecordHandlers = {
		addUndoMeta: () => {},
		editRecord: ( data ) => {
			if ( isBlockList( data.blocks ) ) {
				blocks = data.blocks;
			}
		},
		getEditedRecord: async () => ( {} ),
		onStatusChange: () => {},
		persistCRDTDoc: () => {},
		refetchRecord: async () => {},
		restoreUndoMeta: () => {},
	};

	const transport: ProviderCreator = async ( options ) => {
		session = options.session;
		options.session.onLocalUpdate( ( update ) => unsent.push( update ) );
		return { destroy: () => {}, on: () => {} };
	};

	// The framework remembers the transports it was given, so each tab
	// registers its own.
	resetProviderCreatorsForTesting();
	removeFilter( FILTER, HOOK );
	addFilter( FILTER, HOOK, () => [ transport ] );
	const manager = createIntentLogManager();
	await manager.load( SYNC_CONFIG, ...POST, {}, handlers );

	const connected = (): EngineSessionCodec => {
		if ( ! session ) {
			throw new Error( 'The tab has no connection.' );
		}

		return session;
	};

	connected().receiveUpdate( {
		data: JSON.stringify( { doc: server.initialDoc } ),
		type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
	} );

	return {
		manager,
		sentRows,

		/**
		 * Types at the end of this person's own paragraph.
		 *
		 * @param text The typed text.
		 */
		type( text: string ) {
			blocks = blocks.map( ( block ) => {
				const content = String( block.attributes.content );
				if ( ! content.startsWith( anchor ) ) {
					return block;
				}

				return {
					...block,
					attributes: {
						...block.attributes,
						content: content + text,
					},
				};
			} );
			manager.update( ...POST, { blocks }, 'gutenberg' );
		},

		/**
		 * One polling round trip: send what is waiting, then take the new
		 * rows, the edits set aside, and the answers, in that order.
		 */
		poll() {
			const rows: IntentEnvelope[] = unsent
				.splice( 0 )
				.filter(
					( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
				)
				.map( ( update ) => JSON.parse( update.data ) );
			sentRows.push( ...rows );
			const verdicts = serverIngestBatch( server, rows );

			for ( const row of server.log.slice( rowsSeen ) ) {
				connected().receiveUpdate( {
					data: JSON.stringify( row ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				} );
			}
			rowsSeen = server.log.length;

			for ( const setAside of server.proposals.slice( setAsideSeen ) ) {
				connected().receiveUpdate( {
					data: JSON.stringify( setAside ),
					type: INTENT_LOG_UPDATE_TYPES.PARKED,
				} );
			}
			setAsideSeen = server.proposals.length;

			if ( rows.length > 0 ) {
				connected().receiveDispositions?.(
					verdicts.map( ( verdict, index ) => ( {
						...verdict,
						intentId: rows[ index ].intentId,
					} ) )
				);
			}
		},
	};
}

describe( 'known defect: default attribute values are sent as edits', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		window.__experimentalEnableRealTimeCollaboration = true;
	} );

	afterEach( () => {
		jest.clearAllTimers();
		jest.useRealTimers();
		removeFilter( FILTER, HOOK );
		resetEngineAdaptersForTesting();
		resetConflictSourcesForTesting();
		resetProviderCreatorsForTesting();
		delete window.__experimentalEnableRealTimeCollaboration;
	} );

	// The cause, with one person: typing a word in one paragraph also
	// sends an attribute write for every paragraph in the post.
	it.failing(
		'sends only the typed text for the first edit in a post (known defect, to be fixed by taking edits from the Gutenberg edit batches)',
		async () => {
			const server = createServer( firstServerCopy() );
			const tab = await openTab( server, ANCHORS[ 0 ] );
			jest.advanceTimersByTime( 3000 );

			tab.type( ' w0t0x' );
			tab.poll();

			expect(
				tab.sentRows.map( ( row ) => [ row.type, row.payload.syncId ] )
			).toEqual( [ [ 'insert_text', 'g0' ] ] );
		}
	);

	// What a person sees: the two-person host benchmark, reduced. Each
	// writer types only in their own paragraph, so nothing should be set
	// aside.
	it.failing(
		'sets nothing aside when two people start typing in their own paragraphs at the same time (known defect, to be fixed by taking edits from the Gutenberg edit batches)',
		async () => {
			const server = createServer( firstServerCopy() );
			const writer0 = await openTab( server, ANCHORS[ 0 ] );
			const writer1 = await openTab( server, ANCHORS[ 1 ] );
			jest.advanceTimersByTime( 4000 );

			// The first words, 203 ms apart as in the benchmark. Neither
			// tab has heard from the server in between.
			writer1.type( ' w1t0x' );
			jest.advanceTimersByTime( 203 );
			writer0.type( ' w0t0x' );
			jest.advanceTimersByTime( 300 );
			writer1.poll();
			writer0.poll();

			// A few more words each, then quiet rounds so both tabs catch up.
			for ( let word = 1; word <= 3; word++ ) {
				jest.advanceTimersByTime( 400 );
				writer1.type( ` w1t${ word }x` );
				jest.advanceTimersByTime( 200 );
				writer0.type( ` w0t${ word }x` );
				jest.advanceTimersByTime( 400 );
				writer1.poll();
				writer0.poll();
			}

			for ( let round = 0; round < 4; round++ ) {
				jest.advanceTimersByTime( 1500 );
				writer0.poll();
				writer1.poll();
			}

			// Let the managers publish what they have for review.
			await Promise.resolve();
			await Promise.resolve();

			// Every word arrived. This part works today.
			const final = serverDocAt( server, server.log.length );
			expect( contentText( final, 'g0' ) ).toBe(
				'hostw0anchor w0t0x w0t1x w0t2x w0t3x'
			);
			expect( contentText( final, 'g1' ) ).toBe(
				'hostw1anchor w1t0x w1t1x w1t2x w1t3x'
			);

			// Nothing was set aside, and no tab shows a review card.
			expect(
				server.proposals.map( ( setAside ) => [
					setAside.reason,
					setAside.intent.type,
					setAside.intent.payload.syncId,
					setAside.intent.payload.key,
				] )
			).toEqual( [] );
			expect(
				writer0.manager.conflicts.getOpenConflicts( ...POST )
			).toEqual( [] );
			expect(
				writer1.manager.conflicts.getOpenConflicts( ...POST )
			).toEqual( [] );
		}
	);
} );
