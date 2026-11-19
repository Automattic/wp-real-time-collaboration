/**
 * Internal dependencies
 */
import { serverDocAt } from './intent-log/rebase.js';
import type { EngineDocument, IntentEnvelope } from './intent-log/engine-types';
import {
	createReplica,
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogProposal,
	type ReplicaState,
	type SettledDisposition,
	type StaleBaseRecovery,
} from '../replica/replica';
import { applyServerAwarenessStates } from '../shared/awareness-sync';
import type { PresenceObject } from '../editor/gutenberg-contract';
import type {
	AwarenessState,
	EngineSessionCodec,
	EngineLocalUpdateListener,
	EngineUpdate,
	LocalAwarenessState,
} from '../registry/types';

/*
 * The intent-log engine's session for one room: what a transport and the
 * editor code talk to. The counterpart of WP_Intent_Log_Engine on the
 * server.
 *
 * The room's state lives in the replica (src/replica/replica.ts): the
 * documents, the history, and the one list of everything the server has
 * not answered. This file adds what surrounds it: presence, the listeners,
 * and the names the transports and the editor code call.
 *
 * Wire protocol (see the server class for authority):
 * - receive `snapshot`: start the replica from a whole copy of the document;
 * - receive `intent`: an accepted edit, in the form the server stored;
 * - receive `parked`: an edit set aside for review;
 * - receive `voided`: a marker for an edit that was thrown away;
 * - send `intent` rows for local edits, which are applied here at once;
 * - `dispositions` in the response are the answers, delivered AFTER the
 *   same response's rows (the transport guarantees this order), so the
 *   document never goes backwards inside one response.
 */

/**
 * Slug of the intent-log engine. Must match WP_Intent_Log_Engine::SLUG on the
 * PHP side.
 */
export const INTENT_LOG_ENGINE_SLUG = 'intent-log';

/**
 * Protocol version of the intent-log engine. Must match
 * WP_Intent_Log_Engine::PROTOCOL_VERSION on the PHP side.
 */
export const INTENT_LOG_ENGINE_PROTOCOL = 3;

export { INTENT_LOG_UPDATE_TYPES };
export type {
	IntentLogProposal,
	IntentLogResolution,
	SettledDisposition,
} from '../replica/replica';

export interface IntentLogSessionOptions {
	/** WordPress user id (the authenticated half of the actor id). */
	userId: number;

	/** Per-tab client id; minted when omitted. */
	clientId?: number;

	/**
	 * Presence surface (a y-protocols Awareness instance, constructed over a
	 * stub doc — see createAwarenessDoc). When provided, local awareness is
	 * read from it and server states are applied onto it, so the editor's
	 * collaborator UI works; when omitted, awareness passes through plain
	 * objects (tests, headless use).
	 */
	awareness?: PresenceObject;
}

/** Origin tag for awareness removals applied by this session. */
const INTENT_LOG_SESSION_ORIGIN = 'intent-log-session';

/**
 * The intent-log session: EngineSessionCodec toward the transport, plus the
 * document/intent surface the entity bridge consumes.
 */
export interface IntentLogSession extends EngineSessionCodec {
	/** The server-verifiable actor id this session authors as. */
	actorId: string;

	/** Takes one received row. The same as `receiveUpdates` with one. */
	receiveUpdate: ( update: EngineUpdate ) => void;

	/**
	 * Takes the rows of one answer, in order. A run of accepted edits is
	 * handled in one step, so the person's unanswered edits are planned
	 * again once per run, not once per row.
	 */
	receiveUpdates: ( updates: EngineUpdate[] ) => void;

	/**
	 * The updates to send now, oldest first, within a size budget: the
	 * sum of each update's JSON form plus one byte. They count as on
	 * their way from this call on. Nothing else holds unsent work.
	 */
	takeUpdatesToSend: ( limit: { maxBytes: number } ) => EngineUpdate[];

	/** Whether `takeUpdatesToSend` would return anything. */
	hasUpdatesToSend: () => boolean;

	/**
	 * The connection that carried the updates on their way is gone: a
	 * request failed, a socket closed, or another transport takes the
	 * room. They are handed out again by `takeUpdatesToSend`.
	 */
	connectionLost: () => void;

	/**
	 * Subscribes to "an update can be sent now". The listener gets the
	 * byte length of the update's data.
	 */
	onWorkWaiting: ( listener: ( dataSize: number ) => void ) => void;

	/** Where the room's replica stands (see src/replica/replica.ts). */
	getState: () => ReplicaState;

	/**
	 * Authors one intent against the optimistic document, applies it
	 * locally, and queues it for the transport. Throws before the snapshot
	 * arrives (there is no document to author against).
	 */
	author: (
		type: string,
		payload: Record< string, unknown >,
		options?: { txnId?: string }
	) => IntentEnvelope;

	/**
	 * Authors a batch of intents that were all derived against ONE document
	 * state: the document at `baseSeq`, plus this session's own edits. That
	 * is usually not the optimistic head. Every intent is stamped with
	 * `baseSeq`, so the planner (here and on the server) rebases it over
	 * everything that landed since; the optimistic document is recomputed
	 * once, from the plan, rather than by applying stale coordinates to the
	 * head. `baseSeq` is clamped into the history the replica still holds.
	 */
	authorBatch: (
		intents: Array< { type: string; payload: Record< string, unknown > } >,
		options: { baseSeq: number; txnId?: string }
	) => IntentEnvelope[];

	/**
	 * Records the engine log position of the document the editor shows.
	 * The editor's next edit is made against that document, so the replica
	 * may not trim its log copy below it: the planner needs the rows since
	 * then to rebase the edit.
	 *
	 * The value is clamped into [firstSeq, cursor] and advanced over any
	 * contiguous run of entries this session authored itself: those are
	 * already part of what the editor shows (it is where they came from),
	 * and the one-sided transform skips same-actor priors anyway.
	 */
	setShownSeq: ( seq: number ) => void;

	/**
	 * Pins the replica's log retention at (or below) a seq the undo stack
	 * may still derive inverses from, independent of the shown seq.
	 * `null` releases the pin. The effective retention floor is the MINIMUM
	 * of the shown seq and this pin.
	 */
	setUndoRetainSeq: ( seq: number | null ) => void;

	/**
	 * The document at an absolute log position within the retained window —
	 * the "state before/after row N" an inverse-intent derivation reads.
	 * Read-only. Null pre-snapshot or below the retained floor.
	 */
	getDocumentAt: ( seq: number ) => EngineDocument | null;

	/**
	 * The retained log entries above a position, oldest first, each with
	 * the seq the document has once it applied. Empty when the position
	 * is no longer retained. Conflict review reads the author's own
	 * accepted edits out of it (see intent-log-conflicts.ts).
	 */
	getLogSince: (
		seq: number
	) => Array< { seq: number; intent: IntentEnvelope } >;

	/** The lowest absolute seq the replica's log copy is sliceable from. */
	getRetainedFloor: () => number;

	/**
	 * Subscribes to accepted rows being absorbed into the replica's log
	 * copy, with each row's absolute landing seq — the material an
	 * inverse-intent undo stack settles its units from. Fires for EVERY
	 * accepted row (own and peers').
	 */
	onAcceptedRows: (
		listener: (
			rows: Array< { seq: number; entry: IntentEnvelope } >
		) => void
	) => void;

	/** The optimistic document (acked + pending), or null pre-snapshot. */
	getDocument: () => EngineDocument | null;

	/** Server proposals and conflicts found during local stale-base recovery. */
	getProposals: () => IntentLogProposal[];

	/**
	 * Escalated intents not yet resolved (arrival order): the review list.
	 * Server proposals reconstruct from retained rows. Conflicts found
	 * during stale-base recovery remain in this tab only; there is no
	 * client persistence.
	 */
	getOpenProposals: () => IntentLogProposal[];

	/**
	 * Sends a resolution for a parked proposal. `restored` callers author
	 * the recovered content as ordinary intents FIRST — restoration is a
	 * normal edit; this only closes the proposal. Idempotent server-side.
	 * A proposal found during local recovery closes in this tab only.
	 */
	resolveProposal: (
		proposalId: string,
		resolution: 'restored' | 'dismissed'
	) => void;

	/** Subscribes to review-list changes (proposal arrived or resolved). */
	onProposalsChange: ( listener: () => void ) => void;

	/** Number of authored intents not yet settled by the server. */
	getPendingCount: () => number;

	/**
	 * The authored intents the server has not answered and that this tab
	 * expects it to set aside for review. The tab works this out itself
	 * as soon as it receives the edit they clash with, and takes them out
	 * of its document then. The server's answer, which opens the review
	 * record, comes later.
	 */
	getPredictedSetAside: () => IntentEnvelope[];

	/**
	 * Cancels a set of authored intents that are ALL still unacked —
	 * all-or-nothing (canceling half a unit would strand half an edit).
	 * The intents leave the outbox, the optimistic document replans (the
	 * canvas reverts through the normal change pipeline), and a `cancel`
	 * row chases any copies already queued on the wire: the server drops
	 * intents canceled within the same batch, and acks
	 * `cancel-too-late` when an intent was already ingested — in which
	 * case its accepted row resurrects the effect (nothing is ever
	 * half-lost). The pre-settle undo lane is the caller.
	 *
	 * @return Whether the cancellation was accepted locally (every id
	 *         was still pending).
	 */
	cancelPendingIntents: ( intentIds: string[] ) => boolean;

	/** The engine log position this session has observed (intent rows). */
	getSeq: () => number;

	/**
	 * Whether a newer whole copy of the document waits for the answers to
	 * edits that were sent (the `reset-waiting` state).
	 */
	hasDeferredReset: () => boolean;

	/** Whether the genesis snapshot has arrived. */
	isInitialized: () => boolean;

	/**
	 * The seq of the snapshot this replica (re-)bootstrapped from, or null
	 * pre-snapshot. 0 identifies the room GENESIS — a document derived from
	 * the saved post content every client parsed and rendered on load. A
	 * positive value is a compaction checkpoint, which may carry blocks a
	 * late joiner's editor has never displayed.
	 */
	getBootstrapSeq: () => number | null;

	/** Latest remote awareness states, keyed by client id. */
	getPeers: () => AwarenessState;

	/** Sets the local awareness state sent with each poll. */
	setLocalAwareness: ( state: LocalAwarenessState ) => void;

	/** Subscribes to document changes (local or remote). */
	onChange: ( listener: () => void ) => void;

	/** Subscribes to settled dispositions (the server's acks). */
	onDisposition: (
		listener: ( settled: SettledDisposition ) => void
	) => void;

	/**
	 * Recovers stale-base edits using the retained log's merged document.
	 * Both documents include remote edits and still-pending local work.
	 * The listener authors the difference between them at `seq`.
	 *
	 * Usually this runs after settlement, before a change can push the
	 * reverted document. When a horizon reset is waiting (see onReset),
	 * it runs after the reset has been applied: the two documents are
	 * then older than the checkpoint, and the difference is authored
	 * against the checkpoint.
	 */
	onStaleBaseRecovery: (
		listener: ( recovery: StaleBaseRecovery ) => void
	) => void;

	/** Subscribes to arriving proposals (escalations, any author). */
	onProposal: ( listener: ( proposal: IntentLogProposal ) => void ) => void;

	/**
	 * Subscribes to horizon resets: the server compacted history this
	 * replica never observed and re-bootstrapped it from a checkpoint.
	 * Also fires when the server restarted the room (see onRoomRestart).
	 *
	 * A horizon reset is applied only when no edit that was sent is without
	 * an answer. One that arrives earlier waits, for a limited time (see
	 * RESET_WAIT_LIMIT_MS). The session's document is then the checkpoint. The listener must bring the editor to it
	 * before the editor's next edit is authored: the rows between the old
	 * shown seq and the checkpoint are gone, so an edit made against the
	 * old view cannot be rebased over them.
	 *
	 * An edit made before the reset is not in the checkpoint, unless the
	 * server answered that it stored it. What such edits had changed is
	 * handed to the onStaleBaseRecovery listeners right after the reset.
	 */
	onReset: ( listener: () => void ) => void;

	/**
	 * Transport teardown hook: the transport calls this when it discards
	 * unsent updates at room unregistration (a terminal error dropped the
	 * room). The updates will never reach the server; listeners registered
	 * via onDiscard surface the loss to the user.
	 */
	onUpdatesDiscarded: ( updates: EngineUpdate[] ) => void;

	/** Subscribes to unsent-update discards (see onUpdatesDiscarded). */
	onDiscard: ( listener: ( updates: EngineUpdate[] ) => void ) => void;

	/**
	 * Transport hook: the server restarted the room (its generation
	 * changed), so every row this replica holds is gone. The replica is
	 * dropped and the reset listeners fire, with `isInitialized()` false
	 * until the fresh genesis that follows re-bootstraps it. Always
	 * re-bootstraps: what the editor shows is the durable local state, and
	 * the listener sends the work in it that the new room lacks (see
	 * src/editor/provider.ts).
	 */
	onRoomRestart: () => 'rebootstrap';
}

/**
 * Mints a session clientId in [1, 2^31 - 1], a positive signed 32-bit
 * integer like a Yjs clientID, drawn from crypto randomness so that tabs
 * sharing a site never share an id in practice.
 *
 * @return A fresh clientId.
 */
export function randomClientId(): number {
	const [ word ] = globalThis.crypto.getRandomValues( new Uint32Array( 1 ) );
	return ( word % ( 2 ** 31 - 1 ) ) + 1;
}

/**
 * Creates an intent-log session.
 *
 * @param options Session options.
 * @return The session.
 */
export function createIntentLogSession(
	options: IntentLogSessionOptions
): IntentLogSession {
	const clientId = options.clientId ?? randomClientId();
	const actorId = `u${ options.userId }c${ clientId }`;

	let localUpdateListener: EngineLocalUpdateListener | null = null;
	let localAwareness: LocalAwarenessState = {};
	let peers: AwarenessState = {};
	const workWaitingListeners = new Set< ( dataSize: number ) => void >();
	const proposalsChangeListeners = new Set< () => void >();
	const changeListeners = new Set< () => void >();
	const dispositionListeners = new Set<
		( settled: SettledDisposition ) => void
	>();
	const staleBaseRecoveryListeners = new Set<
		( recovery: StaleBaseRecovery ) => void
	>();
	const proposalListeners = new Set<
		( proposal: IntentLogProposal ) => void
	>();
	const resetListeners = new Set< () => void >();
	const discardListeners = new Set< ( updates: EngineUpdate[] ) => void >();
	const acceptedRowListeners = new Set<
		( rows: Array< { seq: number; entry: IntentEnvelope } > ) => void
	>();

	const textEncoder = new TextEncoder();

	const replica = createReplica( actorId, {
		change: () => changeListeners.forEach( ( listener ) => listener() ),
		workWaiting: ( dataSize ) => {
			workWaitingListeners.forEach( ( listener ) =>
				listener( dataSize )
			);

			/*
			 * A transport that still wants each update handed to it gets
			 * everything that can be sent, at once. It keeps its own queue
			 * from there on.
			 */
			if ( localUpdateListener ) {
				for ( const update of replica.takeToSend( {
					maxBytes: Infinity,
				} ) ) {
					localUpdateListener(
						update,
						textEncoder.encode( update.data ).length
					);
				}
			}
		},
		acceptedRows: ( rows ) =>
			acceptedRowListeners.forEach( ( listener ) => listener( rows ) ),
		settled: ( settled ) =>
			dispositionListeners.forEach( ( listener ) => listener( settled ) ),
		proposal: ( proposal ) =>
			proposalListeners.forEach( ( listener ) => listener( proposal ) ),
		proposalsChange: () =>
			proposalsChangeListeners.forEach( ( listener ) => listener() ),
		reset: () => resetListeners.forEach( ( listener ) => listener() ),
		recovery: ( recovery ) =>
			staleBaseRecoveryListeners.forEach( ( listener ) =>
				listener( recovery )
			),
	} );

	const session: IntentLogSession = {
		actorId,
		clientId,
		engineSlug: INTENT_LOG_ENGINE_SLUG,
		engineProtocol: INTENT_LOG_ENGINE_PROTOCOL,

		// ---- What a transport calls ----

		getInitialUpdates: () => {
			// Nothing to announce: the server sends the first document.
			return [];
		},

		receiveUpdate: ( update ) => {
			replica.receive( [ update ] );
		},

		receiveUpdates: ( updates ) => {
			replica.receive( updates );
		},

		receiveDispositions: ( answers ) => {
			replica.receiveAnswers( answers );
		},

		receiveHeadSeq: ( seq ) => {
			replica.receiveHeadSeq( seq );
		},

		takeRestartRequest: () => replica.takeRestartRequest(),

		takeUpdatesToSend: ( limit ) => replica.takeToSend( limit ),

		hasUpdatesToSend: () => replica.hasWorkToSend(),

		connectionLost: () => {
			replica.connectionLost();
		},

		onWorkWaiting: ( listener ) => {
			workWaitingListeners.add( listener );
		},

		getLocalAwareness: () => {
			if ( options.awareness ) {
				return options.awareness.getLocalState() ?? {};
			}

			return localAwareness;
		},

		applyRemoteAwareness: ( state ) => {
			peers = state;

			if ( options.awareness ) {
				applyServerAwarenessStates(
					state,
					options.awareness,
					INTENT_LOG_SESSION_ORIGIN
				);
			}
		},

		onLocalUpdate: ( listener ) => {
			localUpdateListener = listener;
		},

		destroy: () => {
			replica.destroy();
			localUpdateListener = null;
			workWaitingListeners.clear();
			changeListeners.clear();
			dispositionListeners.clear();
			proposalListeners.clear();
			resetListeners.clear();
			discardListeners.clear();
			proposalsChangeListeners.clear();
			acceptedRowListeners.clear();
		},

		onUpdatesDiscarded: ( updates ) => {
			discardListeners.forEach( ( listener ) => listener( updates ) );
		},

		onRoomRestart: () => {
			replica.restart();

			return 'rebootstrap';
		},

		// ---- What the editor code calls ----

		author: ( type, payload, authorOptions = {} ) =>
			replica.author( type, payload, authorOptions ),

		authorBatch: ( intents, batchOptions ) =>
			replica.authorBatch( intents, batchOptions ),

		setShownSeq: ( seq ) => {
			replica.setShownSeq( seq );
		},

		setUndoRetainSeq: ( seq ) => {
			replica.setUndoRetainSeq( seq );
		},

		getDocumentAt: ( seq ) => {
			const client = replica.getClient();

			if ( ! client || seq < client.firstSeq || seq > client.cursor ) {
				return null;
			}

			return serverDocAt( client, seq );
		},

		getLogSince: ( seq ) => {
			const client = replica.getClient();

			if ( ! client || seq < client.firstSeq ) {
				return [];
			}

			return client.log
				.slice( seq - client.firstSeq )
				.map( ( intent, offset ) => ( {
					seq: seq + offset + 1,
					intent,
				} ) );
		},

		getRetainedFloor: () => replica.getClient()?.firstSeq ?? 0,

		onAcceptedRows: ( listener ) => {
			acceptedRowListeners.add( listener );
		},

		getDocument: () => replica.getClient()?.doc ?? null,
		getProposals: () => replica.getProposals(),
		getOpenProposals: () => replica.getOpenProposals(),
		resolveProposal: ( proposalId, resolution ) => {
			replica.resolveProposal( proposalId, resolution );
		},
		onProposalsChange: ( listener ) => {
			proposalsChangeListeners.add( listener );
		},
		getPendingCount: () => replica.getUnansweredCount(),
		getPredictedSetAside: () => replica.getPredictedSetAside(),
		cancelPendingIntents: ( intentIds ) => replica.cancel( intentIds ),
		getSeq: () => replica.getClient()?.cursor ?? 0,
		getState: () => replica.getState(),
		isInitialized: () => null !== replica.getClient(),
		getBootstrapSeq: () => replica.getBootstrapSeq(),
		getPeers: () => peers,
		setLocalAwareness: ( state ) => {
			localAwareness = state;
		},
		onChange: ( listener ) => {
			changeListeners.add( listener );
		},
		onDisposition: ( listener ) => {
			dispositionListeners.add( listener );
		},
		onStaleBaseRecovery: ( listener ) => {
			staleBaseRecoveryListeners.add( listener );
		},
		onProposal: ( listener ) => {
			proposalListeners.add( listener );
		},
		onReset: ( listener ) => {
			resetListeners.add( listener );
		},
		onDiscard: ( listener ) => {
			discardListeners.add( listener );
		},

		hasDeferredReset: () => 'reset-waiting' === replica.getState(),
	};

	return session;
}
