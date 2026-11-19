/**
 * Internal dependencies
 */
import {
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type { BlockSpec } from '../../../src/engines/intent-log/document.js';
import { createDocument } from '../../../src/engines/intent-log/document.js';
import type {
	EngineDocument,
	IntentEnvelope,
} from '../../../src/engines/intent-log/engine-types';
import type {
	EngineDisposition,
	EngineUpdate,
} from '../../../src/registry/types';

/*
 * A stand-in for the server and the transport, for tests of the browser
 * code. The server side is the engine's own reference server (the planner
 * the PHP server mirrors), so edits are combined, refused and set aside
 * as they are in production. Nothing is sent until a test calls `poll()`,
 * so a test decides when the server's answers arrive.
 */

/** The server side of one room. */
export interface WireServer {
	/** Takes what one tab sent and returns the answer for each edit. */
	ingest: ( sent: EngineUpdate[] ) => EngineDisposition[];
	/** The rows after a position. */
	rowsAfter: ( cursor: number ) => EngineUpdate[];
	/** How many rows the room holds. */
	rowCount: () => number;
	/** The server's document. */
	doc: () => EngineDocument;
}

/**
 * Creates the server side of one room.
 *
 * @param blocks The blocks of the room's first document.
 * @param props  The properties of the room's first document.
 * @return The server.
 */
export function createWireServer(
	blocks: BlockSpec[],
	props: Record< string, unknown > = {}
): WireServer {
	const initialDoc = createDocument( blocks, props );
	const server = createServer( initialDoc );
	const rows: EngineUpdate[] = [
		{
			data: JSON.stringify( { doc: initialDoc } ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		},
	];
	// The edits the server has answered. A cancel for one of them comes
	// too late.
	const answered = new Set< string >();

	return {
		ingest( sent ) {
			const cancelAnswers: EngineDisposition[] = [];
			const cancelledIds = new Set< string >();

			for ( const update of sent ) {
				if ( INTENT_LOG_UPDATE_TYPES.CANCEL !== update.type ) {
					continue;
				}

				const cancel: { cancelId: string; intentIds: string[] } =
					JSON.parse( update.data );

				if ( cancel.intentIds.some( ( id ) => answered.has( id ) ) ) {
					cancelAnswers.push( {
						intentId: cancel.cancelId,
						status: 'voided',
						reason: 'cancel-too-late',
					} );
					continue;
				}

				for ( const id of cancel.intentIds ) {
					cancelledIds.add( id );
					answered.add( id );
					rows.push( {
						data: JSON.stringify( {
							intentId: id,
							reason: 'canceled',
						} ),
						type: INTENT_LOG_UPDATE_TYPES.VOIDED,
					} );
				}

				cancelAnswers.push( {
					intentId: cancel.cancelId,
					status: 'applied',
				} );
			}

			const parsed: IntentEnvelope[] = sent
				.filter(
					( update ) => INTENT_LOG_UPDATE_TYPES.INTENT === update.type
				)
				.map( ( update ) => JSON.parse( update.data ) );
			const dropped = parsed.filter( ( intent ) =>
				cancelledIds.has( intent.intentId )
			);
			const intents = parsed.filter(
				( intent ) => ! cancelledIds.has( intent.intentId )
			);
			const logBefore = server.log.length;
			const proposalsBefore = server.proposals.length;
			const results = serverIngestBatch( server, intents );

			for ( const intent of intents ) {
				answered.add( intent.intentId );
			}

			// As the PHP engine does, each stored edit carries the room's
			// position after it.
			let seq = logBefore;
			for ( const entry of server.log.slice( logBefore ) ) {
				seq += 1;
				rows.push( {
					data: JSON.stringify( { ...entry, seq } ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				} );
			}

			for ( const proposal of server.proposals.slice(
				proposalsBefore
			) ) {
				rows.push( {
					data: JSON.stringify( proposal ),
					type: INTENT_LOG_UPDATE_TYPES.PARKED,
				} );
			}

			return [
				...intents.map( ( intent, index ) => ( {
					intentId: intent.intentId,
					...results[ index ],
				} ) ),
				...dropped.map( ( intent ) => ( {
					intentId: intent.intentId,
					status: 'voided',
					reason: 'canceled',
				} ) ),
				...cancelAnswers,
			];
		},
		rowsAfter: ( cursor ) => rows.slice( cursor ),
		rowCount: () => rows.length,
		doc: () => serverDocAt( server, server.log.length ),
	};
}

/** One tab's connection to the server. */
export interface WireLink {
	/**
	 * One exchange with the server: sends what the tab has queued, hands
	 * the tab the rows it has not seen, then the answers to what it sent.
	 */
	poll: () => EngineDisposition[] | null;
	/** How many updates wait to be sent. */
	queued: () => number;
}

/**
 * Connects a session to a server.
 *
 * @param wire    The server.
 * @param session The tab's session.
 * @return The connection.
 */
export function connectToWire(
	wire: WireServer,
	session: IntentLogSession
): WireLink {
	const queue: EngineUpdate[] = [];
	let cursor = 0;

	session.onLocalUpdate( ( update ) => queue.push( update ) );

	return {
		poll() {
			const sent = queue.splice( 0 );
			const dispositions = sent.length > 0 ? wire.ingest( sent ) : null;
			const updates = wire.rowsAfter( cursor );

			cursor = wire.rowCount();

			for ( const update of updates ) {
				session.receiveUpdate( update );
			}

			if ( dispositions ) {
				session.receiveDispositions?.( dispositions );
			}

			return dispositions;
		},
		queued: () => queue.length,
	};
}
