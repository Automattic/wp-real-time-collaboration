/**
 * Internal dependencies
 */
import {
	authorIntent,
	clientReceive,
	createClient,
	predictedDisposition,
	replanClient,
} from '../engines/intent-log/client.js';
import {
	ESCALATION_REASONS,
	groupUnits,
	planBatch,
	serverDocAt,
} from '../engines/intent-log/rebase.js';
import { createIntent } from '../engines/intent-log/intents.js';
import type {
	EngineDocument,
	IntentDisposition,
	IntentEnvelope,
} from '../engines/intent-log/engine-types';
import type { EngineDisposition, EngineUpdate } from '../registry/types';

/*
 * One room's state in the browser, for the intent-log engine.
 *
 * It holds the document the server confirmed, the history it still needs,
 * the document the person sees (the confirmed one plus their unanswered
 * edits), and ONE list of everything the server has not answered yet: the
 * outgoing list. Nothing else holds unsent work. A transport asks this
 * object what to send and tells it when a connection was lost.
 *
 * The states:
 *
 * - no document: before the first document, or after the room was started
 *   over.
 * - in step: a document, and no unanswered edit.
 * - waiting: a document, and at least one unanswered edit.
 * - reset waiting: the server sent a newer whole copy of the document (a
 *   reset), and an edit that was sent has no answer yet. Only that answer
 *   says whether the new copy holds the edit, so the copy is taken when the
 *   answers are in, or when RESET_WAIT_LIMIT_MS has passed.
 *
 * How edits are combined is the core's business (src/engines/intent-log/).
 * This file decides when the core's functions run and what is sent.
 */

/**
 * Wire kinds, matching WP_Intent_Log_Engine::UPDATE_TYPE_*.
 */
export const INTENT_LOG_UPDATE_TYPES = {
	INTENT: 'intent',
	PARKED: 'parked',
	RESOLVED: 'resolved',
	SNAPSHOT: 'snapshot',
	VOIDED: 'voided',
	// Client-sent only, never stored: cancels edits the server has not
	// accepted yet (undo of an edit that is still on its way).
	CANCEL: 'cancel',
} as const;

/**
 * How long a reset waits for the answers to edits that were sent. After
 * that, an edit with no answer is treated as refused and built again on
 * the new copy. If the server had stored it after all, its text is there
 * twice. That is better than losing it.
 */
export const RESET_WAIT_LIMIT_MS = 10000;

/** How many closed review items the replica remembers (see below). */
const RECENTLY_CLOSED_LIMIT = 256;

/**
 * An escalated intent parked in the proposal lane, as received. The engine
 * enriches rows with the settlement seq, a server timestamp, and a short
 * excerpt of the target field at escalation time (context for review).
 */
export interface IntentLogProposal {
	intent: IntentEnvelope;
	actorId: string;
	reason: string;
	/** Log index of the entry that settled it (planner escalations). */
	atSeq?: number;
	at?: number;
	time?: number;
	context?: { excerpt?: string };
}

/** A proposal's terminal state, as received. */
export interface IntentLogResolution {
	proposalId: string;
	resolution: 'restored' | 'dismissed';
	resolvedBy?: string;
	time?: number;
}

/**
 * An accepted edit as the server stores and relays it: the edit, plus the
 * room's position after it. The first edit of a room has 1.
 */
interface StoredIntent extends IntentEnvelope {
	seq?: number;
}

/**
 * The server's answer for an update it could read an id from. Every
 * update this replica sends has one.
 */
interface IdentifiedDisposition extends EngineDisposition {
	intentId: string;
}

/**
 * Whether an answer names its update by id. The server answers an update
 * with no readable id by its place in the request, and this replica never
 * sends such an update.
 *
 * @param disposition The server's answer for one update.
 */
function hasIntentId(
	disposition: EngineDisposition
): disposition is IdentifiedDisposition {
	return typeof disposition.intentId === 'string';
}

/**
 * A settled outcome surfaced to disposition listeners, joined with the
 * planner's local prediction when one existed.
 */
export interface SettledDisposition extends IdentifiedDisposition {
	predicted?: IntentDisposition | null;
}

/**
 * The local effect lost when the server refuses edits because it no longer
 * holds the history they were made against (stale-base acks).
 */
export interface StaleBaseRecovery {
	/** The document without the refused edits. */
	base: EngineDocument;
	/** The same document with them. */
	target: EngineDocument;
	/** The log position to author the difference at. */
	seq: number;
}

/** The four states of a replica (see the top of this file). */
export type ReplicaState =
	| 'no-document'
	| 'in-step'
	| 'waiting'
	| 'reset-waiting';

/**
 * Where an entry of the outgoing list stands.
 *
 * - `not-sent`: no connection has carried it. The server cannot have it.
 * - `in-flight`: the current connection carried it and no answer is here.
 * - `send-again`: a connection that was lost carried it. The server may
 *   have it. Only its answer can tell.
 * - `refused`: the server refused it while a reset waits. It stays in the
 *   list, and on screen, until the reset is taken and it is built again.
 */
export type OutgoingMark = 'not-sent' | 'in-flight' | 'send-again' | 'refused';

type OutgoingKind = 'intent' | 'resolved' | 'cancel';

interface OutgoingEntry {
	kind: OutgoingKind;
	id: string;
	update: EngineUpdate;
	/** Byte length of the update's data. */
	dataSize: number;
	/** What the update adds to a request: its JSON form plus a comma. */
	cost: number;
	mark: OutgoingMark;
	/** The edit, for an entry of kind `intent`. */
	intent?: IntentEnvelope;
}

/** What a replica tells its owner. Every member is called synchronously. */
export interface ReplicaEvents {
	/** The document changed, or may have. */
	change: () => void;
	/** An entry can be sent now. `dataSize` is its data's byte length. */
	workWaiting: ( dataSize: number ) => void;
	/** Accepted edits joined the history, each with its position. */
	acceptedRows: (
		rows: Array< { seq: number; entry: IntentEnvelope } >
	) => void;
	/** The server answered one update. */
	settled: ( settled: SettledDisposition ) => void;
	/** A set-aside edit arrived, from any author. */
	proposal: ( proposal: IntentLogProposal ) => void;
	/** The review list changed. */
	proposalsChange: () => void;
	/** The replica took a newer whole copy, or the room started over. */
	reset: () => void;
	/** Refused edits to build again (see StaleBaseRecovery). */
	recovery: ( recovery: StaleBaseRecovery ) => void;
}

type CoreClient = ReturnType< typeof createClient >;

const textEncoder = new TextEncoder();

/** One room's state. See the top of this file. */
export interface Replica {
	getState: () => ReplicaState;

	/** The core's state, for reads. Null before the first document. */
	getClient: () => CoreClient | null;

	/** Takes the rows of one answer, in order. */
	receive: ( updates: EngineUpdate[] ) => void;

	/** Takes the server's answers for updates this replica sent. */
	receiveAnswers: ( answers: EngineDisposition[] ) => void;

	/** Takes the room's newest position, sent after a request stored edits. */
	receiveHeadSeq: ( seq: number ) => void;

	/** Whether a row is missing. True is given once. */
	takeRestartRequest: () => boolean;

	/** Drops everything: the room starts over from its first row. */
	restart: () => void;

	author: (
		type: string,
		payload: Record< string, unknown >,
		options?: { txnId?: string }
	) => IntentEnvelope;

	authorBatch: (
		intents: Array< { type: string; payload: Record< string, unknown > } >,
		options: { baseSeq: number; txnId?: string }
	) => IntentEnvelope[];

	/** Takes back edits that have no answer. All of them, or none. */
	cancel: ( intentIds: string[] ) => boolean;

	resolveProposal: (
		proposalId: string,
		resolution: 'restored' | 'dismissed'
	) => void;

	/**
	 * The updates to send now, oldest first, within a size budget. They
	 * count as in flight from this call on.
	 */
	takeToSend: ( limit: { maxBytes: number } ) => EngineUpdate[];

	/** Whether `takeToSend` would return anything. */
	hasWorkToSend: () => boolean;

	/**
	 * The connection that carried the in-flight updates is gone. They are
	 * sent again on the next one.
	 */
	connectionLost: () => void;

	/** The outgoing list, for tests and the inspector. */
	getOutgoing: () => Array< {
		kind: OutgoingKind;
		id: string;
		mark: OutgoingMark;
	} >;

	/** The edits the server has not answered. */
	getUnansweredCount: () => number;

	/** The unanswered edits this replica expects to be set aside. */
	getPredictedSetAside: () => IntentEnvelope[];

	/**
	 * How often an edit that was given up after the reset limit turned
	 * out to be stored by the server, so its text may be there twice.
	 */
	getDoubledAfterResetCount: () => number;

	setShownSeq: ( seq: number ) => void;
	setUndoRetainSeq: ( seq: number | null ) => void;
	getBootstrapSeq: () => number | null;
	getProposals: () => IntentLogProposal[];
	getOpenProposals: () => IntentLogProposal[];

	/** Stops the reset timer. */
	destroy: () => void;
}

/**
 * Creates one room's replica.
 *
 * @param actorId The actor id this tab's edits carry.
 * @param events  What the replica tells its owner.
 * @return The replica.
 */
export function createReplica(
	actorId: string,
	events: ReplicaEvents
): Replica {
	let client: CoreClient | null = null;
	let bootstrapSeq: number | null = null;
	let outgoing: OutgoingEntry[] = [];

	/*
	 * The log position of the document the editor shows (see
	 * setShownSeq). It equals the cursor whenever the editor is caught
	 * up; it lags while updates have reached this replica but not the
	 * editor.
	 */
	let shownSeq = 0;
	/*
	 * The undo history's retention pin, kept apart from shownSeq: neither
	 * can make the replica drop rows the other still needs.
	 */
	let undoRetainSeq: number | null = null;

	/*
	 * The review items that are open, and the ones this tab decided and
	 * the server has not confirmed yet (`resolvedIds`). An item leaves
	 * the list when its decision is confirmed.
	 */
	let proposals: IntentLogProposal[] = [];
	// Conflicts found while building refused edits again exist only in
	// this tab. The server no longer holds what they clash with.
	const localProposalIds = new Set< string >();
	const resolvedIds = new Set< string >();
	/*
	 * The items closed last, newest at the end. A transport can deliver a
	 * row twice within a short window, and the row of an item that was
	 * closed must not open it again. Only that window needs covering, so
	 * the memory is short.
	 */
	let recentlyClosed: string[] = [];

	/*
	 * A reset that waits for answers, the rows that arrived behind it, and
	 * the timer that ends the wait.
	 */
	let waitingReset: {
		update: EngineUpdate;
		seq: number;
		kept: EngineUpdate[];
		timer: ReturnType< typeof setTimeout >;
	} | null = null;

	// Set when a stored row turns out to be missing.
	let restartWanted = false;

	// What refused edits had changed, to hand over once the rows of the
	// current answer are in.
	let recoveries: Array< {
		base: EngineDocument;
		target: EngineDocument;
		proposals: IntentLogProposal[];
	} > = [];

	// Edits given up when the reset limit passed (see RESET_WAIT_LIMIT_MS).
	let givenUp = new Set< string >();
	let doubledAfterReset = 0;

	const findEntry = (
		kind: OutgoingKind,
		id: string
	): OutgoingEntry | undefined =>
		outgoing.find( ( entry ) => entry.kind === kind && entry.id === id );

	/**
	 * Takes an entry off the outgoing list. An edit also leaves the core's
	 * list of unanswered edits, so it is no longer planned as pending.
	 *
	 * @param kind The entry's kind.
	 * @param id   The entry's id.
	 * @return Whether the entry was in the list.
	 */
	const removeEntry = ( kind: OutgoingKind, id: string ): boolean => {
		const before = outgoing.length;

		outgoing = outgoing.filter(
			( entry ) => ! ( entry.kind === kind && entry.id === id )
		);

		if ( outgoing.length === before ) {
			return false;
		}

		if ( 'intent' === kind && client ) {
			client.outbox = client.outbox.filter(
				( intent ) => intent.intentId !== id
			);
		}

		return true;
	};

	/**
	 * Adds an entry to the outgoing list as not sent, and says so, unless
	 * a reset waits: nothing new is sent then.
	 *
	 * @param kind   The entry's kind.
	 * @param id     The entry's id.
	 * @param type   The update's wire kind.
	 * @param value  The update's content.
	 * @param intent The edit, for an entry of kind `intent`.
	 */
	const addEntry = (
		kind: OutgoingKind,
		id: string,
		type: string,
		value: object,
		intent?: IntentEnvelope
	): void => {
		const update: EngineUpdate = { data: JSON.stringify( value ), type };
		const entry: OutgoingEntry = {
			kind,
			id,
			update,
			dataSize: textEncoder.encode( update.data ).length,
			cost: textEncoder.encode( JSON.stringify( update ) ).length + 1,
			mark: 'not-sent',
			intent,
		};

		outgoing.push( entry );

		if ( ! waitingReset ) {
			events.workWaiting( entry.dataSize );
		}
	};

	/**
	 * Whether an edit that was sent has no answer yet.
	 */
	const awaitsAnswers = (): boolean =>
		outgoing.some(
			( entry ) =>
				'intent' === entry.kind &&
				( 'in-flight' === entry.mark || 'send-again' === entry.mark )
		);

	/**
	 * Clamps a shown seq into the range edits can be made at, and skips
	 * the run of own entries above it: those are already part of what the
	 * editor shows.
	 *
	 * @param seq Candidate shown seq.
	 * @return The seq to record.
	 */
	const resolveShownSeq = ( seq: number ): number => {
		if ( ! client ) {
			return seq;
		}

		let resolved = Math.min(
			Math.max( seq, client.firstSeq ),
			client.cursor
		);

		while (
			resolved < client.cursor &&
			client.log[ resolved - client.firstSeq ]?.actorId === actorId
		) {
			resolved++;
		}

		return resolved;
	};

	/**
	 * The settling seq of one of this actor's own planner escalations, or
	 * null when the proposal is not one (a security hold is not a frame
	 * phantom) or carries no seq.
	 *
	 * @param proposal A parked proposal.
	 * @return The settling seq, or null.
	 */
	const ownParkedAtSeq = ( proposal: IntentLogProposal ): number | null => {
		if (
			proposal.actorId !== actorId ||
			! ESCALATION_REASONS.has( proposal.reason )
		) {
			return null;
		}

		if ( 'number' === typeof proposal.atSeq ) {
			return proposal.atSeq;
		}

		if ( 'number' === typeof proposal.at ) {
			return proposal.at - 1;
		}

		return null;
	};

	/**
	 * This actor's set-aside edits with their settling seqs, which every
	 * replan of a fresh core state starts from (see client.js `parked`).
	 *
	 * @return The parks.
	 */
	const ownParked = (): Array< { intent: IntentEnvelope; atSeq: number } > =>
		proposals.flatMap( ( proposal ) => {
			const atSeq = ownParkedAtSeq( proposal );

			if ( null === atSeq ) {
				return [];
			}

			return [ { intent: proposal.intent, atSeq } ];
		} );

	/**
	 * Works out how much history the core must keep: back to the document
	 * the editor shows, to the undo history's pin, and to the base of every
	 * open review item (review rebuilds what the author started from).
	 */
	const applyRetention = (): void => {
		if ( ! client ) {
			return;
		}

		let floor = shownSeq;

		if ( null !== undoRetainSeq ) {
			floor = Math.min( shownSeq, undoRetainSeq );
		}

		for ( const proposal of proposals ) {
			if ( resolvedIds.has( proposal.intent.intentId ) ) {
				continue;
			}

			const baseSeq = Number( proposal.intent.baseSeq );

			if ( Number.isFinite( baseSeq ) && baseSeq >= client.firstSeq ) {
				floor = Math.min( floor, baseSeq );
			}
		}

		client.retainFrom = floor;
	};

	/**
	 * Takes a decided review item off the list for good.
	 *
	 * @param proposalId The item's id.
	 * @return Whether the item was still listed as open.
	 */
	const closeProposal = ( proposalId: string ): boolean => {
		const wasOpen =
			! resolvedIds.has( proposalId ) &&
			proposals.some(
				( proposal ) => proposal.intent.intentId === proposalId
			);

		proposals = proposals.filter(
			( proposal ) => proposal.intent.intentId !== proposalId
		);
		resolvedIds.delete( proposalId );
		localProposalIds.delete( proposalId );
		recentlyClosed = [
			...recentlyClosed.filter( ( id ) => id !== proposalId ),
			proposalId,
		].slice( -RECENTLY_CLOSED_LIMIT );

		return wasOpen;
	};

	const notifyProposalsChange = (): void => {
		// An opened or closed item moves the retention floor.
		applyRetention();
		events.proposalsChange();
	};

	/**
	 * Starts the core state from a whole copy of the document.
	 *
	 * @param doc The document.
	 * @param seq Its position in the room's history.
	 */
	const bootstrap = ( doc: EngineDocument, seq: number ): void => {
		bootstrapSeq = seq;
		client = createClient( actorId, doc, seq );
		client.parked = ownParked();
		shownSeq = seq;
	};

	/**
	 * Takes a reset: a whole copy of the document that is newer than the
	 * history this replica holds. Every unanswered edit was made against
	 * the old history, which the server no longer has, so each is taken
	 * off the list and what it had changed is noted for rebuilding.
	 *
	 * @param doc The new copy.
	 * @param seq Its position in the room's history.
	 */
	const takeReset = ( doc: EngineDocument, seq: number ): void => {
		const old = client;
		const rebuild = outgoing.flatMap( ( entry ) =>
			entry.intent ? [ entry.intent ] : []
		);

		if ( old && rebuild.length > 0 ) {
			const plan = planBatch(
				groupUnits( rebuild ),
				old.log,
				( at ) => serverDocAt( old, at ),
				old.firstSeq
			);

			recoveries.push( {
				base: old.baseDoc,
				target: plan.headDoc,
				// An edit that clashes with a row this tab already had
				// is not in the target. It becomes a review item here.
				proposals: plan.rows.flatMap( ( row ) =>
					row.proposal ? [ row.proposal ] : []
				),
			} );
			outgoing = outgoing.filter( ( entry ) => ! entry.intent );
		}

		bootstrap( doc, seq );
		events.reset();
		events.change();
	};

	/**
	 * Hands over what refused edits had changed, once the rows of the
	 * current answer are in. The owner sends the difference as new edits.
	 */
	const finishRecoveries = (): void => {
		if ( 0 === recoveries.length ) {
			return;
		}

		const pending = recoveries;

		recoveries = [];

		// A missing row means the room starts over. The owner then sends
		// what the editor shows, which includes these edits.
		if ( ! client || restartWanted || waitingReset ) {
			return;
		}

		const seq = client.cursor;
		let listChanged = false;

		for ( const recovery of pending ) {
			events.recovery( {
				base: recovery.base,
				target: recovery.target,
				seq,
			} );

			for ( const proposal of recovery.proposals ) {
				localProposalIds.add( proposal.intent.intentId );
				proposals.push( proposal );
				events.proposal( proposal );
				listChanged = true;
			}
		}

		if ( listChanged ) {
			notifyProposalsChange();
		}

		events.change();
	};

	/**
	 * Applies rows in order. A run of edit rows goes to the core in one
	 * call, so the person's unanswered edits are planned again once per
	 * run, not once per row.
	 *
	 * @param updates The rows.
	 */
	const applyRows = ( updates: EngineUpdate[] ): void => {
		let run: StoredIntent[] = [];

		const flushRun = (): void => {
			if ( ! client || 0 === run.length ) {
				return;
			}

			const entries = run;
			const startSeq = client.cursor;

			run = [];
			clientReceive( client, entries, startSeq );
			events.acceptedRows(
				entries.map( ( entry, index ) => ( {
					seq: startSeq + index,
					entry,
				} ) )
			);
			events.change();
		};

		for ( const update of updates ) {
			// A row is missing. Nothing more is applied until the room
			// starts over.
			if ( restartWanted ) {
				break;
			}

			const decoded = JSON.parse( update.data );

			if ( waitingReset ) {
				const seq = Number( decoded.seq ?? 0 );

				if (
					INTENT_LOG_UPDATE_TYPES.SNAPSHOT === update.type &&
					seq > waitingReset.seq
				) {
					// A newer copy replaces the one that waits, and the
					// rows before it.
					waitingReset.update = update;
					waitingReset.seq = seq;
					waitingReset.kept = [];
				} else {
					// Everything behind a waiting reset stays in order
					// behind it.
					waitingReset.kept.push( update );
				}

				continue;
			}

			if ( INTENT_LOG_UPDATE_TYPES.INTENT !== update.type ) {
				flushRun();
			}

			switch ( update.type ) {
				case INTENT_LOG_UPDATE_TYPES.SNAPSHOT: {
					const seq = Number( decoded.seq ?? 0 );
					const doc: EngineDocument = decoded.doc;

					if ( ! client ) {
						// The first copy wins. The room's first document
						// has seq 0, a later whole copy has its position.
						bootstrap( doc, seq );
						events.change();
						break;
					}

					// A copy at or below the position is a repeat.
					if ( seq <= client.cursor ) {
						break;
					}

					if ( awaitsAnswers() ) {
						waitingReset = {
							update,
							seq,
							kept: [],
							timer: setTimeout(
								endResetWait,
								RESET_WAIT_LIMIT_MS
							),
						};
						break;
					}

					takeReset( doc, seq );
					break;
				}

				case INTENT_LOG_UPDATE_TYPES.INTENT: {
					if ( ! client ) {
						throw new Error(
							'Received an intent before the room snapshot.'
						);
					}

					const intent: StoredIntent = decoded;

					/*
					 * The server stores each edit with the room's position
					 * after it, so the next row must carry the position
					 * this replica has, plus one. A lower number is a row
					 * it has already. A higher one means a row never
					 * arrived: applying this one would put it, and every
					 * edit after it, at the wrong position.
					 */
					const position = client.cursor + run.length;

					if ( typeof intent.seq === 'number' ) {
						if ( intent.seq <= position ) {
							break;
						}

						if ( intent.seq > position + 1 ) {
							restartWanted = true;
							break;
						}
					} else if (
						[ ...client.log, ...run ].some(
							( entry ) => entry.intentId === intent.intentId
						)
					) {
						// Only a hand-written row has no number. One that
						// is in the history already is a repeat.
						break;
					}

					if ( givenUp.delete( intent.intentId ) ) {
						noteDoubled( intent.intentId );
					}

					// The row is the answer too, when the answer was lost.
					removeEntry( 'intent', intent.intentId );
					run.push( intent );
					break;
				}

				case INTENT_LOG_UPDATE_TYPES.PARKED: {
					const proposal: IntentLogProposal = decoded;

					// A row delivered twice must not list the item twice,
					// or open an item again that was closed.
					if (
						recentlyClosed.includes( proposal.intent.intentId ) ||
						proposals.some(
							( existing ) =>
								existing.intent.intentId ===
								proposal.intent.intentId
						)
					) {
						break;
					}

					/*
					 * The edit leaves the list without passing through the
					 * core, so the optimistic document is planned again
					 * here. One of this tab's own set-aside edits also
					 * seeds every later plan: an unanswered edit that still
					 * counts the set-aside text is predicted as the server
					 * will treat it.
					 */
					const atSeq = ownParkedAtSeq( proposal );

					if ( client && null !== atSeq ) {
						client.parked.push( {
							intent: proposal.intent,
							atSeq,
						} );
					}

					const wasUnanswered = removeEntry(
						'intent',
						proposal.intent.intentId
					);

					if ( client && ( wasUnanswered || null !== atSeq ) ) {
						replanClient( client );
					}

					proposals.push( proposal );
					events.proposal( proposal );
					notifyProposalsChange();
					events.change();
					break;
				}

				case INTENT_LOG_UPDATE_TYPES.RESOLVED: {
					const resolution: IntentLogResolution = decoded;

					removeEntry( 'resolved', resolution.proposalId );

					// Confirmed by the server: the item is done with.
					if ( closeProposal( resolution.proposalId ) ) {
						notifyProposalsChange();
					} else {
						applyRetention();
					}

					break;
				}

				case INTENT_LOG_UPDATE_TYPES.VOIDED: {
					// Another tab's marker, or this tab's when the answer
					// was lost.
					if ( removeEntry( 'intent', decoded.intentId ) && client ) {
						replanClient( client );
						events.change();
					}

					break;
				}

				default:
					throw new Error(
						`Unknown intent-log update type: ${ update.type }`
					);
			}
		}

		flushRun();
	};

	/**
	 * Notes that an edit given up after the reset limit was stored by the
	 * server after all. Its text was built again, so it may be there twice.
	 *
	 * @param intentId The edit's id.
	 */
	function noteDoubled( intentId: string ): void {
		doubledAfterReset++;
		// eslint-disable-next-line no-console
		console.warn(
			'[wp-real-time-collaboration] An edit was sent again after a reset, and the server had stored it already. Its text may be there twice.',
			intentId
		);
	}

	/**
	 * Takes the reset that waits, then the rows kept behind it.
	 */
	function releaseReset(): void {
		if ( ! waitingReset ) {
			return;
		}

		const { update, seq, kept, timer } = waitingReset;

		clearTimeout( timer );
		waitingReset = null;

		if ( client && seq > client.cursor ) {
			takeReset( JSON.parse( update.data ).doc, seq );
		}

		applyRows( kept );
		finishRecoveries();

		// What was held back during the wait can go out now.
		for ( const entry of outgoing ) {
			if ( 'not-sent' === entry.mark ) {
				events.workWaiting( entry.dataSize );
			}
		}
	}

	/**
	 * The reset limit passed. Edits that were sent and have no answer are
	 * given up: they are built again like refused ones.
	 */
	function endResetWait(): void {
		if ( ! waitingReset ) {
			return;
		}

		for ( const entry of outgoing ) {
			if (
				'intent' === entry.kind &&
				( 'in-flight' === entry.mark || 'send-again' === entry.mark )
			) {
				givenUp.add( entry.id );
			}
		}

		releaseReset();
	}

	const replica: Replica = {
		getState: () => {
			if ( ! client ) {
				return 'no-document';
			}

			if ( waitingReset ) {
				return 'reset-waiting';
			}

			if ( outgoing.some( ( entry ) => 'intent' === entry.kind ) ) {
				return 'waiting';
			}

			return 'in-step';
		},

		getClient: () => client,

		receive: ( updates ) => {
			try {
				applyRows( updates );
			} finally {
				finishRecoveries();
			}
		},

		receiveAnswers: ( answers ) => {
			const dispositions = answers.filter( hasIntentId );
			let recoveryTarget: EngineDocument | null = null;
			const recoveryProposals: IntentLogProposal[] = [];
			const isStale = ( entry: IdentifiedDisposition ) =>
				'voided' === entry.status && 'stale-base' === entry.reason;

			if ( client && ! waitingReset ) {
				const current = client;
				const staleIds = new Set(
					dispositions
						.filter( isStale )
						.map( ( entry ) => entry.intentId )
				);

				if (
					current.outbox.some( ( entry ) =>
						staleIds.has( entry.intentId )
					)
				) {
					/*
					 * The server no longer has the history these edits
					 * were made against, but this replica does. Work out
					 * what they had changed. Other outcomes of the same
					 * answer are left out: an edit the server set aside
					 * must not be sent again silently.
					 */
					const settledIds = new Set(
						dispositions.map( ( entry ) => entry.intentId )
					);
					const pending = current.outbox.filter(
						( entry ) =>
							! settledIds.has( entry.intentId ) ||
							staleIds.has( entry.intentId )
					);
					const plan = planBatch(
						groupUnits( pending ),
						current.log,
						( seq ) => serverDocAt( current, seq ),
						current.firstSeq
					);

					recoveryTarget = plan.headDoc;

					for ( const row of plan.rows ) {
						if (
							row.proposal &&
							staleIds.has( row.intent.intentId )
						) {
							recoveryProposals.push( row.proposal );
						}
					}
				}
			}

			let settled = false;

			for ( const disposition of dispositions ) {
				const { intentId, status } = disposition;

				if ( 'refused' === status || 'resolved' === status ) {
					removeEntry( 'resolved', intentId );
				}

				if ( 'refused' === status ) {
					/*
					 * The answer to a review decision this tab sent: the
					 * person may not decide that item. The decision was
					 * taken as made when it was sent, so the item is open
					 * again here, as it is on the server.
					 */
					if ( resolvedIds.delete( intentId ) ) {
						notifyProposalsChange();
					}

					continue;
				}

				if ( 'resolved' === status ) {
					// Confirmed by the server: the item is done with.
					if ( closeProposal( intentId ) ) {
						notifyProposalsChange();
					}
				}

				removeEntry( 'cancel', intentId );

				if ( 'applied' === status && givenUp.delete( intentId ) ) {
					noteDoubled( intentId );
				}

				/*
				 * The rows that came before this answer usually settled
				 * the edit already, and the prediction is then null. A tab
				 * that made an edit while behind can also predict wrongly.
				 */
				const predicted = client
					? predictedDisposition( client, intentId )
					: null;
				const entry = findEntry( 'intent', intentId );

				if ( waitingReset && entry && isStale( disposition ) ) {
					// It stays on screen until the reset is taken.
					entry.mark = 'refused';
				} else {
					settled = removeEntry( 'intent', intentId ) || settled;
				}

				events.settled( { ...disposition, predicted } );
			}

			// An edit settled here left the list without a row, so the
			// optimistic document is planned again.
			if ( settled && client ) {
				replanClient( client );
			}

			if ( recoveryTarget && client ) {
				recoveries.push( {
					base: client.doc,
					target: recoveryTarget,
					proposals: recoveryProposals,
				} );
			}

			events.change();
			finishRecoveries();

			if ( waitingReset && ! awaitsAnswers() ) {
				releaseReset();
			}
		},

		receiveHeadSeq: ( seq ) => {
			// The rows of that answer came first, so a replica that is
			// still behind is missing one.
			if ( client && ! waitingReset && seq > client.cursor ) {
				restartWanted = true;
			}
		},

		takeRestartRequest: () => {
			const wanted = restartWanted;

			restartWanted = false;

			return wanted;
		},

		restart: () => {
			if ( waitingReset ) {
				clearTimeout( waitingReset.timer );
			}

			restartWanted = false;
			client = null;
			bootstrapSeq = null;
			shownSeq = 0;
			waitingReset = null;
			recoveries = [];
			outgoing = [];
			givenUp = new Set();
			// The new room sends its own review items. One that exists
			// in this tab only stays: no row will bring it back.
			proposals = proposals.filter( ( proposal ) =>
				localProposalIds.has( proposal.intent.intentId )
			);
			for ( const id of resolvedIds ) {
				if ( ! localProposalIds.has( id ) ) {
					resolvedIds.delete( id );
				}
			}
			recentlyClosed = [];
			events.reset();
			events.change();
		},

		author: ( type, payload, options = {} ) => {
			if ( ! client ) {
				throw new Error(
					'Cannot author intents before the room snapshot arrives.'
				);
			}

			const intent = createIntent( type, payload, {
				actorId,
				baseSeq: client.cursor,
				txnId: options.txnId,
			} );

			authorIntent( client, intent );
			addEntry(
				'intent',
				intent.intentId,
				INTENT_LOG_UPDATE_TYPES.INTENT,
				intent,
				intent
			);
			events.change();

			return intent;
		},

		authorBatch: ( intents, options ) => {
			if ( ! client ) {
				throw new Error(
					'Cannot author intents before the room snapshot arrives.'
				);
			}

			const current = client;
			// The position the edits were worked out at, within the
			// history the replica still holds.
			const baseSeq = Math.min(
				Math.max( options.baseSeq, current.firstSeq ),
				current.cursor
			);
			const authored = intents.map( ( entry ) => {
				const intent = createIntent( entry.type, entry.payload, {
					actorId,
					baseSeq,
					txnId: options.txnId,
				} );

				authorIntent( current, intent );
				addEntry(
					'intent',
					intent.intentId,
					INTENT_LOG_UPDATE_TYPES.INTENT,
					intent,
					intent
				);

				return intent;
			} );

			if ( 0 === authored.length ) {
				return authored;
			}

			if ( baseSeq < current.cursor ) {
				// The edits name places in an older document. Only a plan
				// (the one the server also runs) puts them right on the
				// newest one.
				replanClient( current );
			}

			events.change();

			return authored;
		},

		cancel: ( intentIds ) => {
			// While a reset waits, the outcome of every edit is open.
			if ( ! client || 0 === intentIds.length || waitingReset ) {
				return false;
			}

			const entries = intentIds.map( ( id ) =>
				findEntry( 'intent', id )
			);

			if ( entries.some( ( entry ) => ! entry ) ) {
				// Partly answered: not cancelable.
				return false;
			}

			const neverSent = entries.flatMap( ( entry ) =>
				entry && 'not-sent' === entry.mark ? [ entry.id ] : []
			);

			for ( const id of intentIds ) {
				removeEntry( 'intent', id );
			}

			replanClient( client );

			if ( neverSent.length < intentIds.length ) {
				// Some are on their way. A cancellation follows them.
				addEntry(
					'cancel',
					`cancel-${ intentIds[ 0 ] }`,
					INTENT_LOG_UPDATE_TYPES.CANCEL,
					{ cancelId: `cancel-${ intentIds[ 0 ] }`, intentIds }
				);
			}

			// An edit that was never sent gets no answer from the server.
			// This is its answer.
			for ( const intentId of neverSent ) {
				events.settled( {
					intentId,
					status: 'voided',
					reason: 'canceled',
					predicted: null,
				} );
			}

			events.change();

			return true;
		},

		resolveProposal: ( proposalId, resolution ) => {
			// An item that exists in this tab only closes here only, and
			// nobody else will confirm it.
			if ( localProposalIds.has( proposalId ) ) {
				if ( closeProposal( proposalId ) ) {
					notifyProposalsChange();
				}

				return;
			}

			addEntry(
				'resolved',
				proposalId,
				INTENT_LOG_UPDATE_TYPES.RESOLVED,
				{ proposalId, resolution }
			);

			// The list shrinks at once. The server's row or answer
			// confirms it.
			if ( ! resolvedIds.has( proposalId ) ) {
				resolvedIds.add( proposalId );
				notifyProposalsChange();
			}
		},

		takeToSend: ( { maxBytes } ) => {
			const updates: EngineUpdate[] = [];
			let used = 0;

			if ( ! client ) {
				return updates;
			}

			for ( const entry of outgoing ) {
				if ( 'in-flight' === entry.mark || 'refused' === entry.mark ) {
					continue;
				}

				// While a reset waits, only what the server may hold
				// already is sent, to get its answer.
				if ( waitingReset && 'send-again' !== entry.mark ) {
					continue;
				}

				if ( used + entry.cost > maxBytes ) {
					break;
				}

				used += entry.cost;
				entry.mark = 'in-flight';
				updates.push( entry.update );
			}

			return updates;
		},

		hasWorkToSend: () =>
			null !== client &&
			outgoing.some( ( entry ) => {
				if ( waitingReset ) {
					return 'send-again' === entry.mark;
				}

				return 'not-sent' === entry.mark || 'send-again' === entry.mark;
			} ),

		connectionLost: () => {
			for ( const entry of outgoing ) {
				if ( 'in-flight' === entry.mark ) {
					entry.mark = 'send-again';
					events.workWaiting( entry.dataSize );
				}
			}
		},

		getOutgoing: () =>
			outgoing.map( ( { kind, id, mark } ) => ( { kind, id, mark } ) ),

		getUnansweredCount: () => client?.outbox.length ?? 0,

		getPredictedSetAside: () => {
			if ( ! client ) {
				return [];
			}

			const { predictions } = client;

			return client.outbox.filter(
				( intent ) =>
					'escalated' === predictions.get( intent.intentId )?.status
			);
		},

		getDoubledAfterResetCount: () => doubledAfterReset,

		setShownSeq: ( seq ) => {
			shownSeq = resolveShownSeq( seq );
			applyRetention();
		},

		setUndoRetainSeq: ( seq ) => {
			undoRetainSeq = seq;
			applyRetention();
		},

		getBootstrapSeq: () => bootstrapSeq,
		getProposals: () => [ ...proposals ],
		getOpenProposals: () =>
			proposals.filter(
				( proposal ) => ! resolvedIds.has( proposal.intent.intentId )
			),

		destroy: () => {
			if ( waitingReset ) {
				clearTimeout( waitingReset.timer );
			}
		},
	};

	return replica;
}
