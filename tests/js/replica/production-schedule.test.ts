/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import {
	createReplica,
	INTENT_LOG_UPDATE_TYPES,
	type Replica,
} from '../../../src/replica/replica';
import { createClient } from '../../../src/engines/intent-log/client.js';
import { canonicalJson } from '../../../src/engines/intent-log/document.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type {
	IntentDisposition,
	IntentEnvelope,
} from '../../../src/engines/intent-log/engine-types';
import type {
	EngineDisposition,
	EngineUpdate,
} from '../../../src/registry/types';
import {
	authorRandomIntent,
	makeGenesisDoc,
	mulberry32,
} from '../engines/intent-log/simulator.js';

/*
 * The engine's simulator (tests/js/engines/intent-log/simulator.js) proves
 * the combining rules on one schedule: a tab catches up, sends everything
 * it has not sent as one request, and gets the answers at once.
 *
 * A real tab does not work that way. Over a WebSocket each edit goes out
 * as it is made, several requests are on their way at a time, answers come
 * late, and a connection can die with requests half delivered. This file
 * runs the real replica (src/replica/replica.ts) against the same reference
 * server on such schedules, from a seed, and checks at the end that:
 *
 * - every tab shows the server's document,
 * - every edit got exactly one outcome and no edit was stored twice,
 * - no tab still holds an edit as unanswered,
 * - a tab that was up to date when it sent, with nothing else on its way,
 *   predicted the outcome the server gave.
 *
 * Not covered here: a reset (the reference server keeps its whole history)
 * and an edit made against an older document than the tab's newest. The
 * replica's own tests cover the first, the provider's tests the second.
 */

const REVISION = { postId: 7, revisionId: 1 };
const SEEDS = 60;
const STEPS = 220;
const TABS = 3;

/** The reference server with its rows, as a transport would deliver them. */
function makeRoom() {
	const server = createServer( makeGenesisDoc( REVISION ) );
	const rows: EngineUpdate[] = [
		{
			data: JSON.stringify( { doc: server.initialDoc } ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		},
	];
	const answered = new Set< string >();

	return {
		server,
		rows,
		/**
		 * Takes one request. An edit the server has already is answered
		 * with its first outcome and stores nothing.
		 *
		 * @param sent The request's updates.
		 * @return One answer per update.
		 */
		ingest( sent: EngineUpdate[] ): EngineDisposition[] {
			const intents: IntentEnvelope[] = sent.map( ( update ) =>
				JSON.parse( update.data )
			);
			const logBefore = server.log.length;
			const proposalsBefore = server.proposals.length;
			const outcomes: IntentDisposition[] = serverIngestBatch(
				server,
				intents
			);

			server.log.slice( logBefore ).forEach( ( entry, index ) => {
				rows.push( {
					data: JSON.stringify( {
						...entry,
						seq: logBefore + index + 1,
					} ),
					type: INTENT_LOG_UPDATE_TYPES.INTENT,
				} );
			} );

			for ( const proposal of server.proposals.slice(
				proposalsBefore
			) ) {
				rows.push( {
					data: JSON.stringify( proposal ),
					type: INTENT_LOG_UPDATE_TYPES.PARKED,
				} );
			}

			return intents.map( ( intent, index ) => {
				const outcome = outcomes[ index ];

				if (
					'voided' === outcome.status &&
					! answered.has( intent.intentId )
				) {
					rows.push( {
						data: JSON.stringify( {
							intentId: intent.intentId,
							reason: outcome.reason,
						} ),
						type: INTENT_LOG_UPDATE_TYPES.VOIDED,
					} );
				}

				answered.add( intent.intentId );

				return { intentId: intent.intentId, ...outcome };
			} );
		},
	};
}

type Room = ReturnType< typeof makeRoom >;

/** One tab: a replica and its connection. */
interface Tab {
	actorId: string;
	replica: Replica;
	/** How many of the room's rows the tab has received. */
	rowCursor: number;
	/** Requests on their way, oldest first. */
	onTheirWay: EngineUpdate[][];
	/** The ids of the edits the tab made. */
	authored: string[];
	nextIntent: number;
}

function makeTab( index: number ): Tab {
	const actorId = `u${ index + 1 }c${ index + 11 }`;

	return {
		actorId,
		replica: createReplica( actorId, {
			change: () => {},
			workWaiting: () => {},
			acceptedRows: () => {},
			settled: () => {},
			proposal: () => {},
			proposalsChange: () => {},
			reset: () => {},
			recovery: () => {},
		} ),
		rowCursor: 0,
		onTheirWay: [],
		authored: [],
		nextIntent: 0,
	};
}

/**
 * Hands a tab the rows it has not seen.
 *
 * @param room The room.
 * @param tab  The tab.
 */
function deliverRows( room: Room, tab: Tab ): void {
	const rows = room.rows.slice( tab.rowCursor );

	tab.rowCursor = room.rows.length;
	tab.replica.receive( rows );
}

/**
 * The person makes one random edit (sometimes two that belong together),
 * against what the tab shows.
 *
 * @param tab The tab.
 * @param rng The seeded random numbers.
 */
function edit( tab: Tab, rng: () => number ): void {
	const client = tab.replica.getClient();

	if ( ! client ) {
		return;
	}

	// The simulator's generator works on the core's own client state.
	// A throwaway copy of what the tab shows gives it that.
	const scratch = createClient( tab.actorId, client.doc, client.cursor );

	scratch.nextIntent = tab.nextIntent;

	const intents: IntentEnvelope[] = authorRandomIntent( scratch, rng, {
		propertyOps: true,
	} );

	tab.nextIntent = scratch.nextIntent;

	for ( const intent of intents ) {
		const made = tab.replica.author( intent.type, intent.payload, {
			txnId: intent.txnId ?? undefined,
		} );

		tab.authored.push( made.intentId );
	}
}

/**
 * The oldest request on its way reaches the server, and its answer and
 * the rows the tab has not seen come back.
 *
 * @param room The room.
 * @param tab  The tab.
 */
function answerOldest( room: Room, tab: Tab ): void {
	const request = tab.onTheirWay.shift();

	if ( ! request ) {
		return;
	}

	const answers = room.ingest( request );

	deliverRows( room, tab );
	tab.replica.receiveAnswers( answers );
}

/**
 * The connection dies. The server got some of the requests on their way,
 * oldest first, and no answer comes back for any of them.
 *
 * @param room The room.
 * @param tab  The tab.
 * @param rng  The seeded random numbers.
 */
function loseConnection( room: Room, tab: Tab, rng: () => number ): void {
	const arrived = Math.floor( rng() * ( tab.onTheirWay.length + 1 ) );

	for ( const request of tab.onTheirWay.slice( 0, arrived ) ) {
		room.ingest( request );
	}

	tab.onTheirWay = [];
	tab.replica.connectionLost();
	seen.sentAgain += tab.replica
		.getOutgoing()
		.filter( ( entry ) => 'send-again' === entry.mark ).length;
}

/** What the schedules exercised, summed over all seeds. */
const seen = {
	predictionsChecked: 0,
	setAside: 0,
	sentAgain: 0,
	edits: 0,
};

/**
 * Runs one schedule and returns what went wrong, if anything.
 *
 * @param seed The seed.
 * @return The problems found.
 */
function run( seed: number ): string[] {
	const rng = mulberry32( seed );
	const room = makeRoom();
	const tabs = Array.from( { length: TABS }, ( _, index ) =>
		makeTab( index )
	);
	const problems: string[] = [];

	for ( const tab of tabs ) {
		deliverRows( room, tab );
	}

	/**
	 * Sends what the tab has waiting. When the tab is up to date and
	 * nothing else is on its way, the request is answered at once and
	 * the tab's predictions are compared with the server's outcomes.
	 *
	 * @param tab The tab.
	 */
	const send = ( tab: Tab ): void => {
		const client = tab.replica.getClient();
		const upToDate =
			!! client &&
			client.cursor === room.server.log.length &&
			tab.rowCursor === room.rows.length &&
			0 === tab.onTheirWay.length;
		const updates = tab.replica.takeToSend( { maxBytes: Infinity } );

		if ( 0 === updates.length ) {
			return;
		}

		tab.onTheirWay.push( updates );

		if ( ! client || ! upToDate || rng() < 0.5 ) {
			return;
		}

		const sentIds = new Set(
			updates.map( ( update ) => JSON.parse( update.data ).intentId )
		);
		// Only a request that carries every unanswered edit is one the
		// tab can predict: an edit left out changes what the server sees.
		const whole = tab.replica
			.getOutgoing()
			.every( ( entry ) => sentIds.has( entry.id ) );
		// Read before the answers come in, which replace the predictions.
		const predicted = whole
			? updates.map( ( update ) =>
					client.predictions.get( JSON.parse( update.data ).intentId )
			  )
			: null;
		const answers = room.ingest( updates );

		tab.onTheirWay = [];
		deliverRows( room, tab );
		tab.replica.receiveAnswers( answers );

		if ( ! predicted ) {
			return;
		}

		answers.forEach( ( answer, index ) => {
			const prediction = predicted[ index ];

			seen.predictionsChecked++;

			if (
				prediction?.status !== answer.status ||
				prediction?.reason !== answer.reason
			) {
				problems.push(
					`${ answer.intentId }: predicted ${ JSON.stringify(
						prediction
					) }, the server said ${ JSON.stringify( {
						status: answer.status,
						reason: answer.reason,
					} ) }`
				);
			}
		} );
	};

	for ( let step = 0; step < STEPS; step++ ) {
		const tab = tabs[ Math.floor( rng() * tabs.length ) ];
		const roll = rng();

		if ( roll < 0.45 ) {
			edit( tab, rng );

			// Over an open socket an edit goes out as it is made.
			if ( rng() < 0.6 ) {
				send( tab );
			}
		} else if ( roll < 0.6 ) {
			send( tab );
		} else if ( roll < 0.85 ) {
			answerOldest( room, tab );
		} else if ( roll < 0.93 ) {
			// A poll that carries nothing.
			if ( 0 === tab.onTheirWay.length ) {
				deliverRows( room, tab );
			}
		} else {
			loseConnection( room, tab, rng );
		}
	}

	// Everyone gets a working connection and time to finish.
	for ( let round = 0; round < 4; round++ ) {
		for ( const tab of tabs ) {
			while ( tab.onTheirWay.length > 0 ) {
				answerOldest( room, tab );
			}

			tab.replica.connectionLost();

			const updates = tab.replica.takeToSend( { maxBytes: Infinity } );

			if ( updates.length > 0 ) {
				tab.onTheirWay.push( updates );
				answerOldest( room, tab );
			}

			deliverRows( room, tab );
		}
	}

	const { server } = room;
	const serverJson = canonicalJson(
		serverDocAt( server, server.log.length )
	);

	for ( const tab of tabs ) {
		const client = tab.replica.getClient();

		if ( ! client ) {
			problems.push( `${ tab.actorId }: no document` );
			continue;
		}

		if ( 'in-step' !== tab.replica.getState() ) {
			problems.push(
				`${ tab.actorId }: ends ${ tab.replica.getState() }`
			);
		}

		if ( tab.replica.getOutgoing().length > 0 ) {
			problems.push( `${ tab.actorId }: still holds unanswered work` );
		}

		if ( canonicalJson( client.doc ) !== serverJson ) {
			problems.push( `${ tab.actorId }: shows another document` );
		}

		if ( canonicalJson( client.baseDoc ) !== serverJson ) {
			problems.push( `${ tab.actorId }: confirmed document differs` );
		}

		for ( const intentId of tab.authored ) {
			if ( ! server.dispositions.has( intentId ) ) {
				problems.push( `${ intentId }: the server never got it` );
			}
		}
	}

	seen.edits += server.dispositions.size;
	seen.setAside += server.proposals.length;

	const stored = server.log.map( ( entry ) => entry.intentId );

	if ( new Set( stored ).size !== stored.length ) {
		problems.push( 'an edit was stored twice' );
	}

	return problems;
}

describe( 'real replicas on the schedule a real tab follows', () => {
	it( 'end with the server’s document, every edit answered once, and the outcomes they predicted', () => {
		const failures: string[] = [];

		for ( let seed = 1; seed <= SEEDS; seed++ ) {
			const problems = run( seed );

			if ( problems.length > 0 ) {
				failures.push(
					`seed ${ seed }: ${ problems.slice( 0, 3 ).join( '; ' ) }`
				);
			}
		}

		expect( failures ).toEqual( [] );

		// The schedules really did what this test is about.
		expect( seen.edits ).toBeGreaterThan( 2000 );
		expect( seen.setAside ).toBeGreaterThan( 50 );
		expect( seen.sentAgain ).toBeGreaterThan( 100 );
		expect( seen.predictionsChecked ).toBeGreaterThan( 200 );
	} );
} );
