/**
 * Internal dependencies
 */
import { mintSyncId } from '../engines/intent-log/sync-id.js';
import type { IntentEnvelope } from '../engines/intent-log/engine-types';
import type { IntentLogSession } from '../engines/intent-log-session';
import { deriveInverses } from '../engines/intent-log-undo';

/*
 * Undo and redo for the records the engine syncs.
 *
 * Undo here never rewinds the shared document. It sends new edits that
 * reverse the person's own earlier edits, worked out against what the
 * server accepted. Other people's work stays, and a reverse edit that
 * clashes with it goes to review like any other edit.
 *
 * core-data keeps the order. It holds one placeholder for every undo step
 * the engine reports, in line with the edits it records itself, and asks
 * the engine to undo or redo "the latest step of this record" when a
 * placeholder's turn comes. So this module keeps one stack of steps per
 * record, and every call takes one step off one stack.
 *
 * A step is a group of batches. The editor says where a step begins: the
 * first key of a typing run arrives as a completed change, and the keys
 * after it as changes that are still in progress. There is no clock.
 *
 * A step can be in one of three states when undo is asked for:
 *
 * - The server answered every edit of it. Its reverse edits are sent.
 * - The server answered none. The edits are taken back before they are
 *   sent, or cancelled on the server if they are already on the way.
 * - The server answered some. The undo waits for the rest of the answers
 *   and then sends the reverse edits. The answers are a moment away, so
 *   the person sees the undo a moment later.
 */

/** One edit of a step, and what the server made of it. */
interface StepMember {
	intentId: string;
	status?: 'applied' | 'escalated' | 'voided';
	/** The position the accepted edit has in the room's history. */
	seq?: number;
	/** The edit as the server accepted it. */
	entry?: IntentEnvelope;
}

/** One undo or redo step. */
interface Step {
	members: StepMember[];
	/** Whether the next batch starts a new step. */
	closed: boolean;
	/**
	 * Set while an undo or redo of this step waits for the server's
	 * answers: the step on the other stack that will get the reverse
	 * edits.
	 */
	waitingFor?: Step;
}

/** The two stacks of one record. */
interface RecordHistory {
	session: IntentLogSession;
	undo: Step[];
	redo: Step[];
	onLevelOpened: () => void;
}

/** How many steps of one record can be undone. */
const MAX_STEPS = 20;

/**
 * The undo history of every record the engine has loaded.
 */
export interface UndoHistory {
	/**
	 * Starts a history for a record.
	 *
	 * @param session       The record's session.
	 * @param onLevelOpened Called when a local change opens a new step, so
	 *                      core-data can note it in its own history.
	 */
	attach: ( session: IntentLogSession, onLevelOpened: () => void ) => void;

	/** Drops a record's history. */
	detach: ( session: IntentLogSession ) => void;

	/**
	 * Adds the edits of one local batch to the record's history.
	 *
	 * @param session        The record's session.
	 * @param envelopes      The edits, as the session sent them.
	 * @param startsNewLevel Whether the batch is a completed change. A
	 *                       change still in progress, such as a later key
	 *                       of a typing run, joins the current step.
	 */
	record: (
		session: IntentLogSession,
		envelopes: IntentEnvelope[],
		startsNewLevel: boolean
	) => void;

	/**
	 * Undoes the latest step of a record.
	 *
	 * @return False when there was nothing to undo, or when the step had
	 *         no effect to reverse. core-data then moves on to the step
	 *         before it.
	 */
	undo: ( session: IntentLogSession ) => boolean;

	/** Redoes the step of a record that was undone last. */
	redo: ( session: IntentLogSession ) => boolean;

	/** Closes the current step of every record. */
	stopCapturing: () => void;

	/** Drops the redo steps of every record. */
	clearRedo: () => void;

	/** Drops everything. */
	reset: () => void;
}

/**
 * Creates the undo history.
 *
 * @return The history.
 */
export function createUndoHistory(): UndoHistory {
	const histories = new Map< IntentLogSession, RecordHistory >();
	const byIntentId = new Map<
		string,
		{ history: RecordHistory; step: Step; member: StepMember }
	>();
	// Steps taken back before the server saw them, until the server
	// confirms that it dropped them.
	const cancelled = new Set< Step >();
	// Steps whose undo or redo waits for the server's answers, each with
	// the step on the other stack that will get the reverse edits.
	const waitingSteps = new Map<
		Step,
		{ history: RecordHistory; target: Step }
	>();

	/**
	 * Whether the server answered every edit of a step, and every accepted
	 * edit has arrived back with its place in the history.
	 *
	 * @param step The step.
	 * @return Whether the step is settled.
	 */
	const isSettled = ( step: Step ): boolean =>
		step.members.every(
			( member ) =>
				undefined !== member.status &&
				( 'applied' !== member.status || undefined !== member.entry )
		);

	const isUnanswered = ( step: Step ): boolean =>
		step.members.every(
			( member ) =>
				undefined === member.status && undefined === member.seq
		);

	const forget = ( step: Step ) => {
		for ( const member of step.members ) {
			byIntentId.delete( member.intentId );
		}
	};

	const track = ( history: RecordHistory, step: Step ) => {
		for ( const member of step.members ) {
			byIntentId.set( member.intentId, { history, step, member } );
		}
	};

	/**
	 * Keeps the session's copy of the history long enough to work out the
	 * reverse of the oldest step.
	 *
	 * @param history The record's history.
	 */
	const pinHistory = ( history: RecordHistory ) => {
		let oldest: number | null = null;

		for ( const step of [ ...history.undo, ...history.redo ] ) {
			for ( const member of step.members ) {
				if (
					undefined !== member.seq &&
					( null === oldest || member.seq < oldest )
				) {
					oldest = member.seq;
				}
			}
		}

		history.session.setUndoRetainSeq( oldest );
	};

	/**
	 * Sends the reverse edits of a settled step.
	 *
	 * @param history The record's history.
	 * @param step    The settled step.
	 * @return The reverse edits, as the session sent them.
	 */
	const reverse = (
		history: RecordHistory,
		step: Step
	): IntentEnvelope[] => {
		const { session } = history;
		const currentDoc = session.getDocument();
		const envelopes: IntentEnvelope[] = [];
		const transactions = new Map< string, string >();
		// The latest accepted edit is reversed first.
		const accepted = step.members
			.flatMap( ( member ) => {
				if (
					'applied' === member.status &&
					member.entry &&
					undefined !== member.seq
				) {
					return [ { entry: member.entry, seq: member.seq } ];
				}

				return [];
			} )
			.sort( ( a, b ) => b.seq - a.seq );

		for ( const { entry, seq } of accepted ) {
			const docBefore = session.getDocumentAt( seq );

			if ( ! docBefore ) {
				// The session no longer holds that part of the history.
				continue;
			}

			const inverses = deriveInverses( entry, docBefore, currentDoc );

			if ( 0 === inverses.length ) {
				continue;
			}

			// The reverse edits of one edit apply together or not at all,
			// and so do the reverse edits of a group that applied together.
			let txnId: string | undefined;

			if ( inverses.length > 1 ) {
				txnId = mintSyncId();
			}

			if ( entry.txnId ) {
				txnId = transactions.get( entry.txnId ) ?? mintSyncId();
				transactions.set( entry.txnId, txnId );
			}

			// Each reverse edit is made against the history right after
			// the edit it reverses, so the planner adjusts it around
			// exactly what other people did since.
			envelopes.push(
				...session.authorBatch( inverses, {
					txnId,
					baseSeq: seq + 1,
				} )
			);
		}

		return envelopes;
	};

	/**
	 * Finishes an undo or redo of a settled step: sends its reverse edits
	 * and puts them into the step on the other stack.
	 *
	 * @param history The record's history.
	 * @param step    The settled step.
	 * @param target  The step on the other stack.
	 * @return Whether anything was sent.
	 */
	const finish = (
		history: RecordHistory,
		step: Step,
		target: Step
	): boolean => {
		forget( step );

		const envelopes = reverse( history, step );

		target.members = envelopes.map( ( envelope ) => ( {
			intentId: envelope.intentId,
		} ) );
		track( history, target );
		pinHistory( history );

		return envelopes.length > 0;
	};

	/**
	 * Takes one step off a stack and reverses it.
	 *
	 * @param history The record's history.
	 * @param from    The stack to take the step from.
	 * @param to      The stack that gets the step that reverses it back.
	 * @return Whether the step had, or will have, an effect.
	 */
	const move = (
		history: RecordHistory,
		from: Step[],
		to: Step[]
	): boolean => {
		const step = from.pop();

		if ( ! step ) {
			return false;
		}

		if ( step.waitingFor ) {
			/*
			 * The step is the reverse of another step that still waits for
			 * the server's answers: undo, then redo, in quick succession.
			 * Nothing was sent yet, so the first request is called off and
			 * the other step goes back where it was.
			 */
			const original = step.waitingFor;

			waitingSteps.delete( original );
			step.waitingFor = undefined;
			to.push( original );

			return true;
		}

		if ( 0 === step.members.length ) {
			return false;
		}

		if ( isSettled( step ) ) {
			const target: Step = { members: [], closed: true };
			const sent = finish( history, step, target );

			if ( sent ) {
				to.push( target );
			}

			return sent;
		}

		if ( from === history.undo && isUnanswered( step ) ) {
			// Nothing of the step reached the server yet. Take the edits
			// back. They stay known, so that an answer that says the server
			// had them after all can bring the step back.
			if (
				history.session.cancelPendingIntents(
					step.members.map( ( member ) => member.intentId )
				)
			) {
				cancelled.add( step );

				return true;
			}
		}

		// Some answers are still on their way. Finish when they are in.
		const target: Step = { members: [], closed: true, waitingFor: step };

		to.push( target );
		step.closed = true;
		// The step stays findable by its edits, off both stacks.
		waitingSteps.set( step, { history, target } );

		return true;
	};

	const finishWaiting = ( step: Step ) => {
		const waiting = waitingSteps.get( step );

		if ( ! waiting || ! isSettled( step ) ) {
			return;
		}

		waitingSteps.delete( step );

		const { history, target } = waiting;
		const sent = finish( history, step, target );
		const stack = [ history.undo, history.redo ].find( ( candidate ) =>
			candidate.includes( target )
		);

		target.waitingFor = undefined;

		if ( ! stack ) {
			// A newer edit ended the redo history in the meantime. The
			// reverse edits were still sent, but they are not a step.
			forget( target );
		} else if ( ! sent ) {
			// Nothing to reverse after all.
			stack.splice( stack.indexOf( target ), 1 );
		}
	};

	const clearRedo = () => {
		for ( const history of histories.values() ) {
			// A redo step that still waits to be filled is dropped too. The
			// undo it belongs to is still carried out (see finishWaiting).
			for ( const step of history.redo.splice( 0 ) ) {
				forget( step );
			}

			pinHistory( history );
		}
	};

	return {
		attach( session, onLevelOpened ) {
			if ( histories.has( session ) ) {
				return;
			}

			const history: RecordHistory = {
				session,
				undo: [],
				redo: [],
				onLevelOpened,
			};

			histories.set( session, history );

			session.onAcceptedRows( ( rows ) => {
				for ( const { seq, entry } of rows ) {
					const tracked = byIntentId.get( entry.intentId );

					if ( ! tracked ) {
						continue;
					}

					tracked.member.status = 'applied';
					tracked.member.seq = seq;
					tracked.member.entry = entry;
					finishWaiting( tracked.step );
				}

				pinHistory( history );
			} );

			session.onDisposition( ( settled ) => {
				const tracked = byIntentId.get( settled.intentId );

				if ( ! tracked ) {
					return;
				}

				const { step, member } = tracked;

				if ( 'escalated' === settled.status ) {
					member.status = 'escalated';
				} else if ( 'voided' === settled.status ) {
					member.status = 'voided';
				} else if ( undefined === member.status ) {
					member.status = 'applied';
				}

				if ( cancelled.has( step ) ) {
					const confirmed =
						'voided' === settled.status &&
						'canceled' === settled.reason;

					if ( ! confirmed ) {
						// The server had the edit before the cancel reached
						// it, so its effect comes back. The step is a step
						// again.
						cancelled.delete( step );
						history.undo.push( step );
					} else if (
						step.members.every(
							( other ) => 'voided' === other.status
						)
					) {
						cancelled.delete( step );
						forget( step );
					}
				}

				finishWaiting( step );
			} );

			session.onReset( () => {
				// The room started again from a newer copy. The history
				// the steps were worked out against is gone.
				for ( const step of [ ...history.undo, ...history.redo ] ) {
					forget( step );
				}

				history.undo.splice( 0 );
				history.redo.splice( 0 );
				pinHistory( history );
			} );
		},

		detach( session ) {
			const history = histories.get( session );

			if ( ! history ) {
				return;
			}

			for ( const step of [ ...history.undo, ...history.redo ] ) {
				forget( step );
			}

			session.setUndoRetainSeq( null );
			histories.delete( session );
		},

		record( session, envelopes, startsNewLevel ) {
			const history = histories.get( session );

			if ( ! history || 0 === envelopes.length ) {
				return;
			}

			// A new edit ends the redo history.
			clearRedo();

			const members = envelopes.map( ( envelope ) => ( {
				intentId: envelope.intentId,
			} ) );
			const top = history.undo.at( -1 );

			if ( top && ! top.closed && ! startsNewLevel ) {
				top.members.push( ...members );
				track( history, top );

				return;
			}

			const step: Step = { members, closed: false };

			history.undo.push( step );
			track( history, step );

			while ( history.undo.length > MAX_STEPS ) {
				const dropped = history.undo.shift();

				if ( dropped ) {
					forget( dropped );
				}
			}

			pinHistory( history );
			history.onLevelOpened();
		},

		undo( session ) {
			const history = histories.get( session );

			if ( ! history ) {
				return false;
			}

			return move( history, history.undo, history.redo );
		},

		redo( session ) {
			const history = histories.get( session );

			if ( ! history ) {
				return false;
			}

			return move( history, history.redo, history.undo );
		},

		stopCapturing() {
			for ( const history of histories.values() ) {
				const top = history.undo.at( -1 );

				if ( top ) {
					top.closed = true;
				}
			}
		},

		clearRedo,

		reset() {
			for ( const history of histories.values() ) {
				history.session.setUndoRetainSeq( null );
			}

			histories.clear();
			byIntentId.clear();
			cancelled.clear();
			waitingSteps.clear();
		},
	};
}
