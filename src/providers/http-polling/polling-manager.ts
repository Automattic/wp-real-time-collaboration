/**
 * Internal dependencies
 */
import { getClientLimitPerRoom } from '../connection-limit';
import {
	ERROR_RETRY_DELAYS_SOLO_MS,
	ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS,
	MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES,
	MIN_SYNC_REQUEST_BODY_SIZE_LIMIT_IN_BYTES,
	MAX_ROOMS_PER_REQUEST,
	MAX_UPDATE_SIZE_IN_BYTES,
	POLLING_INTERVAL_IN_MS,
	POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS,
	POLLING_INTERVAL_BACKGROUND_TAB_IN_MS,
	DISCONNECT_DIALOG_RETRY_MS,
	MANUAL_RETRY_INTERVAL_MS,
	LOCAL_UPDATE_POLL_DELAY_MS,
	ANNOUNCE_POLL_COALESCE_MS,
	ANNOUNCE_POLL_MIN_GAP_MS,
	FAST_DISCOVERY_WINDOW_MS,
} from './config';
import {
	ConnectionError,
	ConnectionErrorCode,
} from '../../registry/connection-error';
import {
	advisoryCoversClients,
	getChannelPresence,
	onAdvisoryAnnounce,
	onAdvisoryCoverageChanged,
	onAdvisoryPresence,
	setPresenceSource,
	startAdvisoryChannel,
	stopAdvisoryChannel,
} from '../advisory/channel';
import { announceLocalWrite } from '../advisory/announce';
import { BLOCK_FIELD } from '../../awareness/channels/sync-channel';
import {
	applyAnswer,
	buildProbe,
	probeFailed,
	installSignaling,
	installSignalingLifecycle,
	isSignalingAvailable,
	onOthersChanged,
	onRoomCursor,
	onRoomEngine,
	othersPresent,
	getPresenceRoom,
	getPresenceToken,
	setSignalCarrier,
	setSyncClientId,
} from '../advisory/signaling';
import type {
	ConnectionStatus,
	EngineDisposition,
	EngineSessionCodec,
} from '../../registry/types';
import type { TransportSessionCodec } from '../session-extensions';
import {
	installSyncDebug,
	isSyncDebugEnabled,
	recordPoll,
	registerDebugSession,
	unregisterDebugSession,
} from '../../debug/inspector';
import type {
	AwarenessState,
	SyncPayload,
	SyncResponse,
	SyncUpdate,
} from './types';
import {
	postSyncUpdate,
	postSyncUpdateNonBlocking,
	rotateWindow,
} from './utils';

type LogFunction = (
	message: string,
	debug?: object,
	errorLevel?: 'error' | 'log' | 'warn',
	force?: boolean
) => void;

interface PollingManager {
	registerRoom: ( options: RegisterRoomOptions ) => void;
	releaseRoom: ( room: string ) => Promise< ReleasedRoom >;
	retryNow: () => void;
	unregisterRoom: (
		room: string,
		options?: { sendDisconnectSignal?: boolean }
	) => void;
}

interface RegisterRoomOptions {
	room: string;
	session: EngineSessionCodec;
	log: LogFunction;
	onStatusChange: ( status: ConnectionStatus ) => void;
	/**
	 * Where to resume in the room's history: a preferred transport
	 * (websocket) hands a room to short polling at the cursor its socket
	 * had reached, so nothing is replayed or skipped.
	 */
	initialCursor?: number;
}

/**
 * What a preferred transport takes back when it reclaims a room from
 * short polling (see releaseRoom).
 */
export interface ReleasedRoom {
	cursor: number;
}

interface RoomState {
	endCursor: number;
	/** The room generation this session bootstrapped under (see types). */
	generation?: string;
	isPrimaryRoom: boolean;
	/** The awareness map the last poll response carried for this room. */
	lastServerAwareness: AwarenessState;
	log: LogFunction;
	onStatusChange: ( status: ConnectionStatus ) => void;
	room: string;
	session: EngineSessionCodec;
	unregister: () => void;
}

/**
 * Minimal shape of a WordPress REST API error as it arrives on the client
 * via apiFetch. WP_Error is serialized to JSON with a `data.status` field
 * containing the HTTP status code; `code` and `message` are best-effort.
 */
interface WPRestError {
	code?: string;
	message?: string;
	data: { status: number; rooms?: string[]; room?: string };
}

/**
 * Check if an error is a forbidden (403) response from the WordPress REST
 * API. These errors have a `data.status` property set by WP_Error.
 *
 * @param error The caught error to inspect.
 */
function isForbiddenError( error: unknown ): error is WPRestError {
	return ( error as WPRestError | undefined )?.data?.status === 403;
}

/**
 * Check if an error is the sync server's deterministic request-body-size
 * rejection. The server rejects this before the sync handler stores updates, so
 * the client can safely retry the exact same updates in smaller request bodies.
 *
 * @param error The caught error to inspect.
 */
function isRequestBodyTooLargeError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.data?.status === 413 &&
		( error as WPRestError | undefined )?.code ===
			'rest_sync_body_too_large'
	);
}

/**
 * Check if an error is the sync server's protocol mismatch signal. This
 * indicates the client is running an outdated version of the code that is
 * incompatible with the server, and the user should refresh to recover.
 *
 * @param error The caught error to inspect.
 */
function isProtocolMismatchError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.code ===
		'rest_sync_protocol_mismatch'
	);
}

/**
 * Check if an error is the sync server's engine mismatch signal (409). The
 * room is bound to a different sync engine than this client speaks — either
 * the site configuration changed mid-session (stale tab) or the room's
 * storage lineage predates an engine swap. Retrying cannot succeed; the
 * affected room must fall back to the lock posture.
 *
 * @param error The caught error to inspect.
 */
function isEngineMismatchError( error: unknown ): error is WPRestError {
	return (
		( error as WPRestError | undefined )?.code ===
		'rest_sync_engine_mismatch'
	);
}

/**
 * Handle a 403 from the sync endpoint. Silently unregisters the affected
 * rooms listed in the error data. The updates of the remaining rooms go
 * out again on the next poll.
 *
 * If the error does not include room details, it is treated as a generic auth
 * failure and all rooms are unregistered.
 *
 * @param error          The forbidden error, narrowed via isForbiddenError.
 * @param requestedRooms The rooms that were in the failing request.
 */
function handleForbiddenError(
	error: WPRestError,
	requestedRooms: SyncPayload[ 'rooms' ]
): void {
	const requestedRoomNames = new Set(
		requestedRooms.map( ( room ) => room.room )
	);
	const forbiddenRooms = Array.isArray( error.data.rooms )
		? error.data.rooms.filter( ( room ) => requestedRoomNames.has( room ) )
		: [];

	if ( forbiddenRooms.length > 0 ) {
		for ( const room of forbiddenRooms ) {
			const state = roomStates.get( room );
			if ( state ) {
				state.log(
					'Permission denied, unregistering room',
					{ error },
					'error',
					true // force
				);
				unregisterRoom( room, { sendDisconnectSignal: false } );
			}
		}

		for ( const room of requestedRooms ) {
			if ( forbiddenRooms.includes( room.room ) ) {
				continue;
			}
			if ( ! roomStates.has( room.room ) ) {
				continue;
			}
			// The request never got through: its updates go out again.
			roomStates.get( room.room )?.session.connectionLost();
		}
	} else {
		// Generic auth failure (e.g. not logged in) — unregister all rooms.
		const rooms = [ ...roomStates.keys() ];
		for ( const room of rooms ) {
			const state = roomStates.get( room );
			if ( state ) {
				state.log(
					'Permission denied, unregistering room',
					{ error },
					'error',
					true // force
				);
				unregisterRoom( room, { sendDisconnectSignal: false } );
			}
		}
	}
}

/**
 * Handle a 409 engine mismatch from the sync endpoint. The server rejects the
 * whole request on the first mismatched room, naming it in the error data.
 * That room is terminally incompatible — its status is set to disconnected
 * with an ENGINE_MISMATCH error (the lock posture) and it is unregistered
 * without a disconnect signal (the server would 409 that request too).
 * The updates of the other rooms in the request go out again on the next
 * poll.
 *
 * Without a room in the error data (defensively), all requested rooms are
 * treated as mismatched.
 *
 * @param error          The mismatch error, narrowed via isEngineMismatchError.
 * @param requestedRooms The rooms that were in the failing request.
 */
function handleEngineMismatchError(
	error: WPRestError,
	requestedRooms: SyncPayload[ 'rooms' ]
): void {
	const mismatchedRooms =
		'string' === typeof error.data.room
			? [ error.data.room ]
			: requestedRooms.map( ( room ) => room.room );

	for ( const room of mismatchedRooms ) {
		const state = roomStates.get( room );
		if ( ! state ) {
			continue;
		}
		state.log(
			'Sync engine mismatch, unregistering room',
			{ error },
			'error',
			true // force
		);
		state.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.ENGINE_MISMATCH,
				'Sync engine mismatch between client and server'
			),
		} );
		unregisterRoom( room, { sendDisconnectSignal: false } );
	}

	for ( const room of requestedRooms ) {
		if ( mismatchedRooms.includes( room.room ) ) {
			continue;
		}
		if ( ! roomStates.has( room.room ) ) {
			continue;
		}
		// The request never got through: its updates go out again.
		roomStates.get( room.room )?.session.connectionLost();
	}
}

const roomStates: Map< string, RoomState > = new Map();

// Console stub for the sync inspector (wpSync.enable() and friends).
installSyncDebug();

/**
 * Check whether the awareness state exceeds the configured connection limit.
 *
 * @param awareness The awareness state from the server response.
 * @param roomState The room state corresponding to the awareness state
 * @return True if a peer limit has been exceeded.
 */
function checkConnectionLimit(
	awareness: AwarenessState,
	roomState: RoomState
): boolean {
	if ( ! roomState.isPrimaryRoom || hasCheckedConnectionLimit ) {
		return false;
	}

	// Limits are only enforced on the initial connection.
	hasCheckedConnectionLimit = true;

	const clientCount = Object.keys( awareness ).length;
	const validatedLimit = getClientLimitPerRoom( roomState.room );

	if ( clientCount > validatedLimit ) {
		roomState.log( 'Connection limit exceeded', {
			clientCount,
			maxClientsPerRoom: validatedLimit,
			room: roomState.room,
		} );

		return true;
	}

	return false;
}

let areListenersRegistered = false;
let consecutiveFailures = 0;
let hasCheckedConnectionLimit = false;
let isManualRetry = false;
let hasCollaborators = false;
let isActiveBrowser = 'visible' === document.visibilityState;
let isPolling = false;
let isUnloadPending = false;
let pollInterval = POLLING_INTERVAL_IN_MS;
let pollingTimeoutId: ReturnType< typeof setTimeout > | null = null;
/*
 * Set when a room restarted under us during this poll: the next poll must
 * follow at once (cursor 0) instead of waiting out the interval.
 */
let repollImmediately = false;
let syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;

/*
 * THE CADENCE RULES (docs/transports.md).
 *
 * Short polling is the base transport everyone has. What changes is WHEN
 * the loop polls:
 *
 * - Alone (the signaling lane says nobody else is in this post's room):
 *   no timer once the first poll has brought the document (except a
 *   30 s discovery window after load and after regaining focus). Local
 *   edits are sent at most once per polling interval, and at once before
 *   a save and when the tab goes hidden. Company (a heartbeat or poll
 *   answer, or an awareness map with more than one client) brings the
 *   timer back.
 * - Company, but some known peer is NOT reachable over the advisory
 *   channel: today's timer cadence (the configured interval).
 * - Company, every known peer reachable over the channel: no timer at
 *   all. Polls happen on demand — after a queued local update, after a
 *   peer announces new rows, and when a heartbeat answer reports the
 *   room's head cursor ahead of this tab's (rows from writers not on
 *   the channel: scripts, WP-CLI, a dropped peer). The heartbeat slows
 *   to 120 s on blur, so a backgrounded tab notices such a write late;
 *   accepted, nobody is looking.
 * - No signaling lane on this page (a screen with no per-post room, or
 *   the channel disabled site-wide): the always-on cadence, unchanged.
 */
let hasBootstrapped = false;
let pollAgainRequested = false;
let hiddenFlushTimer: ReturnType< typeof setTimeout > | null = null;
/*
 * A lone tab has no timer, so it would notice a joiner on its next
 * heartbeat (10 s) at best. For a while after the page loads and
 * after the tab regains focus — the moments a second person most often
 * turns up — it polls at the solo cadence instead (4 s by default).
 */
let fastDiscoveryUntil = 0;
/*
 * Polls started and finished. Every poll carries the updates that wait,
 * so this is what a flush waits for.
 */
let lastPollStartedAt = 0;
let sendsStarted = 0;
let sendsFinished = 0;
/** Whether the poll in flight is counted as started and not yet finished. */
let pollInFlightCounted = false;
/** Flush waiters: resolve once poll number `target` has finished. */
const sendDoneResolvers: Array< { target: number; resolve: () => void } > = [];
let localUpdatePollTimer: ReturnType< typeof setTimeout > | null = null;
let announcePollTimer: ReturnType< typeof setTimeout > | null = null;
let lastAnnouncePollAt = 0;
let advisoryHooksInstalled = false;

function hasQueuedUpdates(): boolean {
	for ( const state of roomStates.values() ) {
		if ( state.session.hasUpdatesToSend() ) {
			return true;
		}
	}
	return false;
}

function isAlone(): boolean {
	return isSignalingAvailable() && ! hasCollaborators && ! othersPresent();
}

/**
 * How long local work waits before a poll is made for it. With company
 * it is a short delay that lets the rest of a burst pile in. Alone,
 * nobody is reading, so one request per polling interval is enough.
 */
function localWorkDelay(): number {
	if ( ! isAlone() ) {
		return LOCAL_UPDATE_POLL_DELAY_MS;
	}

	return Math.max(
		LOCAL_UPDATE_POLL_DELAY_MS,
		lastPollStartedAt + POLLING_INTERVAL_IN_MS - Date.now()
	);
}

/**
 * Never let a slow (or absent) timer sit on queued local work: a
 * background delay, or no timer at all, is cut down to the on-demand
 * send delay (the normal timer cadences send soon enough). The cadence
 * rules decide how often to LOOK for rows; queued rows go out promptly
 * regardless (found when a peer joined the channel and a pending 1 s
 * timer was dropped while an undo's inverse intents were queued).
 *
 * @param delay The delay the cadence rules chose.
 */
function boundedByQueuedWork( delay: number | null ): number | null {
	if (
		hasQueuedUpdates() &&
		( null === delay || delay >= POLLING_INTERVAL_BACKGROUND_TAB_IN_MS )
	) {
		return localWorkDelay();
	}
	return delay;
}

/**
 * Sends what waits now, and resolves once that request has returned (or
 * failed). Used before a save and when the tab goes hidden.
 */
export function flushUpdatesNow(): Promise< void > {
	if ( 0 === roomStates.size || ! hasQueuedUpdates() ) {
		return Promise.resolve();
	}
	return new Promise< void >( ( resolve ) => {
		// Wait for a request that STARTS after this call: a request
		// already in flight was built before, so its successor is the
		// one that carries the work.
		sendDoneResolvers.push( { target: sendsStarted + 1, resolve } );
		pollNow();
	} );
}

function cancelHiddenFlush(): void {
	if ( hiddenFlushTimer ) {
		clearTimeout( hiddenFlushTimer );
		hiddenFlushTimer = null;
	}
}

function hasCompany(): boolean {
	return hasCollaborators || othersPresent();
}

/**
 * Whether every peer this tab knows about is reachable over the advisory
 * channel: the discovered tokens, and the client ids the primary room's
 * last awareness map carried.
 */
function advisoryCoversEveryone(): boolean {
	const clientIds: number[] = [];
	roomStates.forEach( ( state ) => {
		if ( state.isPrimaryRoom ) {
			for ( const id of Object.keys( state.lastServerAwareness ) ) {
				clientIds.push( Number( id ) );
			}
		}
	} );
	return advisoryCoversClients( clientIds );
}

/**
 * The delay before the next scheduled poll after a successful one, or null
 * for "do not schedule" (quiet while alone).
 */
function nextScheduledDelay(): number | null {
	if ( hasBootstrapped && isAlone() ) {
		// Alone: the discovery window, then quiet. The heartbeat's
		// company report restarts the loop.
		if ( Date.now() >= fastDiscoveryUntil ) {
			return null;
		}
		return POLLING_INTERVAL_IN_MS;
	}
	if ( advisoryCoversEveryone() ) {
		return null;
	}
	if ( ! isActiveBrowser ) {
		return POLLING_INTERVAL_BACKGROUND_TAB_IN_MS;
	}
	if ( hasCompany() ) {
		return POLLING_INTERVAL_WITH_COLLABORATORS_IN_MS;
	}
	return POLLING_INTERVAL_IN_MS;
}

/**
 * Schedules the next poll, or leaves the loop stopped when the cadence
 * rules say so. `isPolling` stays true only while a poll is scheduled or
 * in flight, so a stopped loop can be restarted by any wake path.
 *
 * @param delay Milliseconds until the next poll, or null to stop.
 */
function scheduleNext( delay: number | null ): void {
	if ( pollAgainRequested ) {
		// A wake arrived while the last request was in flight. If that
		// request failed, its wait stands (see pollNow()).
		pollAgainRequested = false;
		if ( 0 === consecutiveFailures ) {
			pollingTimeoutId = setTimeout( poll, 0 );
			return;
		}
	}
	if ( null === delay ) {
		isPolling = false;
		pollingTimeoutId = null;
		return;
	}
	pollingTimeoutId = setTimeout( poll, delay );
}

/**
 * Polls now: a stopped loop restarts, a scheduled poll is brought forward,
 * an in-flight poll is followed by another as soon as it returns.
 *
 * One exception: the wait after a failed request stands. While requests
 * fail, the wake paths (a local edit, an announcement, a queued handshake
 * message) can fire many times a second, and each retry that fails at
 * once counts toward the "connection lost" dialog. An offline tab would
 * show it within a moment. Only the dialog's own Retry button retries at
 * once.
 */
function pollNow(): void {
	if ( 0 === roomStates.size ) {
		return;
	}
	if ( consecutiveFailures > 0 && ! isManualRetry ) {
		if ( pollingTimeoutId ) {
			// The retry is scheduled. It carries whatever woke us.
			return;
		}
		if ( isPolling ) {
			// A request is in flight. If it fails too, its own wait
			// follows, not another request.
			return;
		}
	}
	if ( pollingTimeoutId ) {
		clearTimeout( pollingTimeoutId );
		pollingTimeoutId = null;
		poll();
		return;
	}
	if ( ! isPolling ) {
		poll();
		return;
	}
	pollAgainRequested = true;
}

/**
 * Re-evaluates a pending timer against the cadence rules (a peer joined
 * or left the channel, company arrived). A stopped loop restarts only
 * when there is company; an in-flight poll reschedules itself when it
 * returns.
 */
function reschedule(): void {
	if ( 0 === roomStates.size ) {
		return;
	}
	if ( pollingTimeoutId ) {
		clearTimeout( pollingTimeoutId );
		pollingTimeoutId = null;
		const delay = boundedByQueuedWork( nextScheduledDelay() );
		if ( null === delay ) {
			isPolling = false;
			return;
		}
		pollingTimeoutId = setTimeout( poll, delay );
		return;
	}
	if ( ! isPolling && hasCompany() ) {
		poll();
	}
}

/**
 * Local work is waiting: send it on demand when no timer will pick it up
 * soon. That is when the loop is quiet (alone), a request is in flight
 * with nothing scheduled behind it (alone, mid-poll), or every peer is on
 * the channel, where the loop keeps no regular timer. A scheduled timer
 * at the normal cadence needs no help.
 */
function wakeForLocalWork(): void {
	if ( ! pollingTimeoutId || isAlone() || advisoryCoversEveryone() ) {
		pollSoonForLocalUpdate();
	}
}

/**
 * Local work waits while no timer will pick it up soon: poll shortly. The
 * delay lets the rest of a burst pile in; it is NOT reset by later
 * updates, so a long burst cannot starve the send.
 */
function pollSoonForLocalUpdate(): void {
	if ( localUpdatePollTimer ) {
		return;
	}
	localUpdatePollTimer = setTimeout( () => {
		localUpdatePollTimer = null;
		// Another poll may have carried the work in the meantime.
		if ( hasQueuedUpdates() ) {
			pollNow();
		}
	}, localWorkDelay() );
}

/**
 * A peer announced new rows over the advisory channel: poll, coalescing a
 * burst of announcements into one request and never faster than the floor.
 */
function pollSoonForAnnounce(): void {
	if ( announcePollTimer ) {
		return;
	}
	const sinceLast = Date.now() - lastAnnouncePollAt;
	const delay = Math.max(
		ANNOUNCE_POLL_COALESCE_MS,
		ANNOUNCE_POLL_MIN_GAP_MS - sinceLast
	);
	announcePollTimer = setTimeout( () => {
		announcePollTimer = null;
		lastAnnouncePollAt = Date.now();
		pollNow();
	}, delay );
}

/**
 * The awareness map to hand a session: the poll response's copy with the
 * fresher channel copy overlaid for peers on the channel (a 25-second-old
 * server cursor must not jump a live cursor back).
 *
 * @param state The room.
 */
function mergedAwareness( state: RoomState ): AwarenessState {
	const merged: AwarenessState = { ...state.lastServerAwareness };
	const channel = getChannelPresence( state.room ) as AwarenessState;
	for ( const clientId of Object.keys( channel ) ) {
		const base = channel[ clientId ];
		const server = merged[ clientId ];
		merged[ clientId ] =
			base && 'object' === typeof base
				? {
						...( server && 'object' === typeof server
							? server
							: {} ),
						...base,
				  }
				: server ?? base;
	}
	return merged;
}

const BASE_PRESENCE_FIELDS = [
	'collaboratorInfo',
	'name',
	'isActive',
	BLOCK_FIELD,
];

/**
 * The part of an awareness state that says WHO this is and, under slow
 * awareness, WHICH BLOCK they are in (not where their cursor is): the
 * fields the channel carries.
 *
 * @param state The local awareness state.
 */
function basePresence( state: unknown ): unknown {
	if ( ! state || 'object' !== typeof state ) {
		return state;
	}
	const picked: Record< string, unknown > = {};
	for ( const field of BASE_PRESENCE_FIELDS ) {
		if ( field in ( state as Record< string, unknown > ) ) {
			picked[ field ] = ( state as Record< string, unknown > )[ field ];
		}
	}
	return picked;
}

function installAdvisoryHooks(): void {
	if ( advisoryHooksInstalled ) {
		return;
	}
	advisoryHooksInstalled = true;
	installSignaling();
	installSignalingLifecycle();
	onOthersChanged( ( others ) => {
		if ( others ) {
			pollNow();
		} else {
			reschedule();
		}
	} );
	// An active loop carries queued handshake messages on its next poll;
	// a quiet one leaves them to the heartbeat.
	setSignalCarrier( () => {
		if ( isPolling ) {
			pollNow();
			return true;
		}
		return false;
	} );
	onAdvisoryCoverageChanged( reschedule );
	onAdvisoryAnnounce( pollSoonForAnnounce );
	onRoomCursor( ( cursor ) => {
		// Rows landed that no nudge announced (a writer off the channel):
		// the primary room's cursor is behind the head the beat reported.
		roomStates.forEach( ( state ) => {
			if ( state.isPrimaryRoom && cursor > state.endCursor ) {
				pollSoonForAnnounce();
			}
		} );
	} );
	onRoomEngine( ( engine ) => {
		// The site's engine changed under this session: poll so the
		// server's 409 fence drops the room into the lock posture.
		roomStates.forEach( ( state ) => {
			if (
				state.isPrimaryRoom &&
				state.session.engineSlug &&
				engine !== state.session.engineSlug
			) {
				pollNow();
			}
		} );
	} );
	onAdvisoryPresence( ( room ) => {
		const state = roomStates.get( room );
		if ( state ) {
			state.session.applyRemoteAwareness( mergedAwareness( state ) );
		}
	} );
	// Only BASE presence rides the channel (who is here: user info, name,
	// activity, and the slow-awareness block name, which names a block
	// the receiver may not hold yet and then shows nothing until it
	// does). Cursors and selections stay on the polls by decision: over
	// the channel they would point at content positions the receiver
	// has not polled for yet.
	setPresenceSource( () =>
		Array.from( roomStates.values() ).map( ( state ) => ( {
			room: state.room,
			clientId: state.session.clientId,
			state: basePresence( state.session.getLocalAwareness() ),
		} ) )
	);
}

// How long a tab going hidden waits before sending what waits (pagehide,
// which follows a hide on reload/close, cancels it).
const HIDDEN_FLUSH_DELAY_MS = 1500;

// When more rooms are registered than the server allows per request
// (MAX_ROOMS_PER_REQUEST), the primary room is sent every poll and the
// remaining "overflow" rooms are rotated across polls. This offset
// points into the overflow list at the next room to include.
let roomOverflowOffset = 0;

/**
 * Mark that a page unload has been requested. This fires on
 * `beforeunload` which happens before the browser aborts in-flight
 * fetches, allowing us to distinguish poll failures caused by
 * navigation from genuine server errors in the catch block.
 *
 * If the user cancels the unload (e.g. by dismissing a "Save Changes?" dialog),
 * the flag is reset at the start of the next poll cycle so that polling can
 * resume.
 */
function handleBeforeUnload(): void {
	isUnloadPending = true;
}

/**
 * Send a disconnect signal for all registered rooms when the page is
 * being unloaded. Uses `sendBeacon` so the request survives navigation.
 */
function handlePageHide(): void {
	cancelHiddenFlush();
	const rooms = Array.from( roomStates.entries() ).map(
		( [ room, state ] ) => ( {
			after: 0,
			awareness: null,
			client_id: state.session.clientId,
			room,
			updates: [],
		} )
	);

	for ( let i = 0; i < rooms.length; i += MAX_ROOMS_PER_REQUEST ) {
		postSyncUpdateNonBlocking( {
			rooms: rooms.slice( i, i + MAX_ROOMS_PER_REQUEST ),
		} );
	}
}

/**
 * Hangle change in visibility state of browser tab.
 *
 * Used to trigger a slow down of the collaboration syncs when the
 * browser tab becomes inactive (either the user switches tabs or the
 * screen saver comes on).
 *
 * Fires on the document's visibilitychange event.
 */
function handleVisibilityChange() {
	const wasActive = isActiveBrowser;
	isActiveBrowser = document.visibilityState === 'visible';

	if ( ! isActiveBrowser ) {
		/*
		 * Going hidden while alone with unsent work: a hidden tab's heartbeat
		 * slows to two minutes, too slow to answer a joiner, so put the
		 * work in the room once. Hiding is also the first thing a
		 * reload or close does (visibilitychange precedes pagehide), so
		 * the flush waits a beat and pagehide cancels it.
		 */
		cancelHiddenFlush();
		if ( isAlone() && hasQueuedUpdates() ) {
			hiddenFlushTimer = setTimeout( () => {
				hiddenFlushTimer = null;
				void flushUpdatesNow();
			}, HIDDEN_FLUSH_DELAY_MS );
		}
		return;
	}
	cancelHiddenFlush();

	if ( isActiveBrowser && ! wasActive ) {
		fastDiscoveryUntil = Date.now() + FAST_DISCOVERY_WINDOW_MS;
		/*
		 * Remove scheduled polling and repoll immediately when reactivated.
		 *
		 * This ensures that any updates by collaborators are immediately
		 * reflected in the document once the browser tab becomes active.
		 * Otherwise there would be a delay of up to 30 seconds before the
		 * updates came through.
		 *
		 * Only repoll if we cleared a pending timeout, meaning the poll loop
		 * was idle between cycles. If no timeout is pending, a poll request
		 * is already in-flight and will pick up the updated isActiveBrowser
		 * value when it schedules the next cycle.
		 */
		if ( pollingTimeoutId ) {
			clearTimeout( pollingTimeoutId );
			pollingTimeoutId = null;
			poll();
		} else if ( ! isPolling && 0 < roomStates.size ) {
			// A stopped loop: poll once now (company may have arrived while
			// hidden, and the discovery window just reopened).
			poll();
		}
	}
}

/**
 * Select which rooms to include in the next sync request.
 *
 * The server caps requests at MAX_ROOMS_PER_REQUEST rooms. When fewer rooms are
 * registered than the cap, every room is included on every poll. When the cap
 * is exceeded, the primary room is sent on every poll (so the main document
 * stays fully synced) and the remaining overflow rooms are rotated across
 * successive polls so each one is included (at a reduced frequency).
 *
 * Rooms that are skipped on a given poll keep their queued updates; the updates
 * are drained on the next poll that includes them.
 *
 * @return The RoomStates to include in this request, in send order.
 */
function selectRoomsForRequest(): RoomState[] {
	const allRooms = Array.from( roomStates.values() );

	// Fast path: everything fits in a single request.
	if ( allRooms.length <= MAX_ROOMS_PER_REQUEST ) {
		return allRooms;
	}

	// Rotation path: pin the primary room to every request (if one exists)
	// and rotate the remaining overflow rooms across successive polls.
	const primaryRoom = allRooms.find( ( state ) => state.isPrimaryRoom );
	const overflowRooms = allRooms.filter( ( state ) => state !== primaryRoom );
	const overflowSlotsPerRequest =
		MAX_ROOMS_PER_REQUEST - ( primaryRoom ? 1 : 0 );

	const { window: overflowSlice, nextOffset } = rotateWindow(
		overflowRooms,
		roomOverflowOffset,
		overflowSlotsPerRequest
	);
	roomOverflowOffset = nextOffset;

	if ( primaryRoom ) {
		return [ primaryRoom, ...overflowSlice ];
	}

	return overflowSlice;
}

const textEncoder = new TextEncoder();

function getJsonByteLength( value: unknown ): number {
	return textEncoder.encode( JSON.stringify( value ) ).byteLength;
}

function createPayloadRoom(
	state: RoomState,
	updates: SyncUpdate[] = []
): SyncPayload[ 'rooms' ][ number ] {
	return {
		after: state.endCursor ?? 0,
		awareness: state.session.getLocalAwareness(),
		client_id: state.session.clientId,
		...( state.session.engineSlug
			? {
					engine: state.session.engineSlug,
					engine_protocol: state.session.engineProtocol,
			  }
			: {} ),
		// This tab's presence token, on its post's room only: the first
		// request carrying it is the tab's join (docs/transports.md).
		...( getPresenceRoom() === state.room && getPresenceToken()
			? { presence_token: getPresenceToken()! }
			: {} ),
		// The inspector's server-envelope opt-in (see debug/inspector.ts).
		...( isSyncDebugEnabled() ? { debug: true } : {} ),
		room: state.room,
		updates,
	};
}

/**
 * Builds the request for the given rooms. Each room's session hands over
 * the updates that wait, within what is left of the body-size limit.
 *
 * @param selectedRoomStates The rooms, in send order.
 */
function buildPayloadForRequest( selectedRoomStates: RoomState[] ): {
	payload: SyncPayload;
	roomsInRequest: RoomState[];
} {
	const payload: SyncPayload = { rooms: [] };
	const roomsInRequest: RoomState[] = [];
	const probe = isSignalingAvailable() ? buildProbe() : null;
	if ( probe ) {
		payload.advisory = probe;
	}

	for ( const state of selectedRoomStates ) {
		const room = createPayloadRoom( state );
		const candidate = { rooms: [ ...payload.rooms, room ] };
		if (
			payload.rooms.length > 0 &&
			getJsonByteLength( candidate ) > syncRequestBodySizeLimit
		) {
			break;
		}

		payload.rooms.push( room );
		roomsInRequest.push( state );
	}

	let payloadSize = getJsonByteLength( payload );

	for ( let i = 0; i < roomsInRequest.length; i++ ) {
		const updates = roomsInRequest[ i ].session.takeUpdatesToSend( {
			maxBytes: syncRequestBodySizeLimit - payloadSize,
		} );

		payload.rooms[ i ].updates = updates;
		payloadSize += getJsonByteLength( updates );
	}

	return { payload, roomsInRequest };
}

/**
 * Tells the sessions of a request that it did not get through, so its
 * updates go out again.
 *
 * @param payload The request.
 */
function markRequestLost( payload: SyncPayload ): void {
	for ( const room of payload.rooms ) {
		roomStates.get( room.room )?.session.connectionLost();
	}
}

/**
 * Applies one room's rows, then its dispositions, in that order. Rows
 * already settle the pending state they supersede, so the answers cover
 * only outcomes without a row and the session's state never goes
 * backwards inside one response.
 *
 * @param state        The room.
 * @param updates      The rows to apply.
 * @param dispositions The server's verdicts on rows this client sent.
 */
function applyRoomRows(
	state: RoomState,
	updates: SyncUpdate[],
	dispositions: EngineDisposition[] | undefined
): void {
	try {
		state.session.receiveUpdates( updates );
	} catch ( error ) {
		state.log(
			'Failed to apply sync updates',
			{ error, updates },
			'error',
			true // force
		);
	}

	if ( dispositions && state.session.receiveDispositions ) {
		try {
			state.session.receiveDispositions( dispositions );
		} catch ( error ) {
			state.log(
				'Failed to apply dispositions',
				{ error },
				'error',
				true // force
			);
		}
	}
}

/**
 * Applies one room's response envelope.
 *
 * @param state       The room.
 * @param room        Its envelope in the response.
 * @param sentUpdates How many updates the request carried for this room.
 */
function applyRoomResponse(
	state: RoomState,
	room: SyncResponse[ 'rooms' ][ number ],
	sentUpdates: number
): void {
	/*
	 * Room generation: the server restarted this room (reset to
	 * a fresh genesis from the saved post) if the token differs
	 * from the one we bootstrapped under. Nothing else in this
	 * response is ours to apply — its rows belong to the new
	 * room and are re-fetched from cursor 0 by the immediate
	 * re-poll (or the room is dropped, per the session).
	 */
	if ( 'string' === typeof room.generation ) {
		if ( undefined === state.generation ) {
			state.generation = room.generation;
		} else if ( state.generation !== room.generation ) {
			restartRoom( state, room.generation, room.updates );
			return;
		}
	}

	state.endCursor = room.end_cursor;

	// If a limit is exceeded, disconnect immediately without processing updates.
	if ( checkConnectionLimit( room.awareness, state ) ) {
		state.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.CONNECTION_LIMIT_EXCEEDED,
				'Connection limit exceeded'
			),
		} );
		unregisterRoom( room.room );
		return;
	}

	// Process awareness update: the server's copy, with the
	// fresher channel copy overlaid for peers on the channel.
	state.lastServerAwareness = room.awareness ?? {};
	state.session.applyRemoteAwareness( mergedAwareness( state ) );

	// Another collaborator on the primary entity means company:
	// the loop keeps its timer cadence (or polls on demand
	// under full channel coverage). Only the primary room is
	// checked to avoid false positives from shared collection
	// rooms (e.g. taxonomy/category).
	if ( state.isPrimaryRoom && Object.keys( room.awareness ).length > 1 ) {
		hasCollaborators = true;
	}

	// Rows this tab just landed: tell the peers on the channel
	// to poll. A rumor only — the poll is what delivers them.
	if ( sentUpdates ) {
		announceLocalWrite( room.room );
	}

	applyRoomRows( state, room.updates, room.dispositions );

	if ( 'number' === typeof room.seq ) {
		state.session.receiveHeadSeq?.( room.seq );
	}

	// The session found that it missed a row: read the room again from
	// its first row, as after a restart of the room by the server.
	if ( state.session.takeRestartRequest?.() ) {
		restartRoom( state, state.generation, [] );
	}
}

/**
 * Applies a whole response: every room still registered, in order, with
 * the inspector's wire tap.
 *
 * @param rooms     The response envelopes.
 * @param payload   The request they answer.
 * @param startedAt When the request started (for the inspector).
 */
function applyResponseRooms(
	rooms: SyncResponse[ 'rooms' ],
	payload: SyncPayload,
	startedAt: number
): void {
	// Reset before checking each room
	hasCollaborators = false;

	rooms.forEach( ( room ) => {
		const state = roomStates.get( room.room );
		if ( ! state ) {
			return;
		}

		const requested = payload.rooms.find(
			( sent ) => sent.room === room.room
		);

		// The inspector's wire tap: decoded traffic, both ways.
		if ( isSyncDebugEnabled() ) {
			recordPoll( {
				room: room.room,
				sent: requested?.updates ?? [],
				received: room.updates,
				dispositions: room.dispositions as
					| Array< Record< string, unknown > >
					| undefined,
				cursorBefore: requested?.after,
				cursorAfter: room.end_cursor,
				durationMs: Date.now() - startedAt,
				serverDebug: (
					room as {
						_debug?: Record< string, unknown >;
					}
				 )._debug,
			} );
		}

		applyRoomResponse( state, room, requested?.updates.length ?? 0 );
	} );
}

/**
 * A request came back: the rooms it carried are connected.
 *
 * @param roomsInRequest The rooms the request carried.
 */
function markConnected( roomsInRequest: RoomState[] ): void {
	consecutiveFailures = 0;
	isManualRetry = false;
	syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;
	roomsInRequest.forEach( ( state ) => {
		// Skip rooms unregistered during the await (e.g. the
		// size-limit handler in onDocUpdate). Their terminal
		// status was already set by whatever unregistered them.
		if ( roomStates.get( state.room ) !== state ) {
			return;
		}

		state.onStatusChange( { status: 'connected' } );
	} );
}

/**
 * Handles a failed request: permission and engine fences drop the
 * affected rooms, a too-large body shrinks the next one, a protocol
 * mismatch ends everything, and anything else backs off and sends the
 * same updates again.
 *
 * @param error          What the request threw.
 * @param payload        The request.
 * @param roomsInRequest The rooms it carried.
 * @param startedAt      When it started (for the inspector).
 * @return Whether the loop must stop: every room is gone, or the server
 *         cannot speak our protocol.
 */
function handleRequestFailure(
	error: unknown,
	payload: SyncPayload,
	roomsInRequest: RoomState[],
	startedAt: number
): boolean {
	if ( isSyncDebugEnabled() ) {
		for ( const requested of payload.rooms ) {
			recordPoll( {
				room: requested.room,
				sent: requested.updates,
				received: [],
				durationMs: Date.now() - startedAt,
				error: String( error ),
			} );
		}
	}

	// A 403 response means the user does not have permission to
	// sync a specific entity. Silently unregister the affected
	// room(s) and let polling continue for the rest.
	if ( isForbiddenError( error ) ) {
		handleForbiddenError( error, payload.rooms );
		// If every room was unregistered, stop the poll loop instead of
		// scheduling another tick.
		return roomStates.size === 0;
	}

	if ( isEngineMismatchError( error ) ) {
		// A 409 means the room is bound to a different sync engine.
		// Retrying can never succeed — drop the affected room into
		// the lock posture and keep polling for the rest.
		handleEngineMismatchError( error, payload.rooms );
		return roomStates.size === 0;
	}

	if ( isRequestBodyTooLargeError( error ) ) {
		syncRequestBodySizeLimit = Math.max(
			MIN_SYNC_REQUEST_BODY_SIZE_LIMIT_IN_BYTES,
			Math.floor( syncRequestBodySizeLimit / 2 )
		);
		pollInterval = hasCollaborators
			? ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS[ 0 ]
			: ERROR_RETRY_DELAYS_SOLO_MS[ 0 ];
		markRequestLost( payload );

		for ( const room of payload.rooms ) {
			if ( ! roomStates.has( room.room ) ) {
				continue;
			}

			roomStates.get( room.room )!.log(
				'Sync request body too large, retrying with smaller batches',
				{
					error,
					nextPoll: pollInterval,
					syncRequestBodySizeLimit,
				},
				'error',
				true // force
			);
		}
		return false;
	}

	if ( isProtocolMismatchError( error ) ) {
		// The server explicitly signaled a protocol mismatch, so we fail
		// gracefully instead of retrying indefinitely. This can happen if
		// the client is running an outdated version of the code that is
		// incompatible with the server.
		const affectedRooms = [ ...roomStates.entries() ];

		for ( const [ , state ] of affectedRooms ) {
			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.PROTOCOL_MISMATCH,
					'Protocol mismatch between client and server'
				),
			} );
		}

		// Skip the server-side disconnect signal: by definition the
		// server can't speak our protocol, so sending one is pointless.
		for ( const [ room ] of affectedRooms ) {
			unregisterRoom( room, { sendDisconnectSignal: false } );
		}

		return true;
	}

	// Use the explicit retry delay schedule for backoff.
	consecutiveFailures++;
	const retrySchedule = hasCollaborators
		? ERROR_RETRY_DELAYS_WITH_COLLABORATORS_MS
		: ERROR_RETRY_DELAYS_SOLO_MS;
	if ( consecutiveFailures <= retrySchedule.length ) {
		pollInterval = retrySchedule[ consecutiveFailures - 1 ];
	} else {
		pollInterval = DISCONNECT_DIALOG_RETRY_MS;
	}

	// After a manual retry, use a shorter interval for one cycle.
	if ( isManualRetry ) {
		pollInterval = MANUAL_RETRY_INTERVAL_MS;
		isManualRetry = false;
	}

	// We do not know whether the server stored the updates before the
	// error (a timeout after a successful write, say). They go out again.
	// The server knows an update it has already by its id.
	markRequestLost( payload );

	for ( const room of payload.rooms ) {
		roomStates.get( room.room )?.log(
			'Error posting sync update, will retry with backoff',
			{ error, nextPoll: pollInterval },
			'error',
			true // force
		);
	}

	// Don't report disconnected status when the request was aborted
	// due to page unload (e.g. during a refresh) to avoid briefly
	// flashing the disconnect dialog before the new page loads.
	if ( ! isUnloadPending ) {
		const backgroundRetriesFailed =
			consecutiveFailures > retrySchedule.length;

		roomsInRequest.forEach( ( state ) => {
			// Skip rooms unregistered during the await so
			// their terminal status isn't overwritten.
			if ( roomStates.get( state.room ) !== state ) {
				return;
			}

			state.onStatusChange( {
				status: 'disconnected',
				canManuallyRetry: true,
				consecutiveFailures,
				backgroundRetriesFailed,
				willAutoRetryInMs: pollInterval,
			} );
		} );
	}

	return false;
}

/**
 * Finishes a poll: the flush waiters count these.
 */
function finishSend(): void {
	sendsFinished++;
	for ( const waiter of sendDoneResolvers.splice( 0 ) ) {
		if ( waiter.target <= sendsFinished ) {
			waiter.resolve();
		} else {
			sendDoneResolvers.push( waiter );
		}
	}
}

function poll(): void {
	isPolling = true;
	pollingTimeoutId = null;

	async function start(): Promise< void > {
		if ( 0 === roomStates.size ) {
			isPolling = false;
			return;
		}

		// Reset the unloading flag at the start of each poll cycle so
		// it doesn't permanently suppress disconnect after the user
		// cancels a beforeunload dialog.
		isUnloadPending = false;

		// Create a payload with queued updates. We include rooms even if they
		// have no updates to ensure we receive any incoming updates, while keeping
		// the serialized body below the server's aggregate request-size limit.
		const { payload, roomsInRequest } = buildPayloadForRequest(
			selectRoomsForRequest()
		);
		pollInFlightCounted = true;
		sendsStarted++;
		lastPollStartedAt = Date.now();

		// Emit 'connecting' status only for rooms in this request. Rooms
		// rotated out of this poll keep their prior status.
		roomsInRequest.forEach( ( state ) => {
			state.onStatusChange( { status: 'connecting' } );
		} );

		const pollStarted = Date.now();
		let succeeded = false;
		let nextDelay: number | null = null;
		try {
			const { rooms, advisory } = await postSyncUpdate( payload );
			// The signaling answer rode this poll: company, peers, mailbox.
			applyAnswer( advisory, payload.advisory?.seq );

			markConnected( roomsInRequest );
			applyResponseRooms( rooms, payload, pollStarted );

			// The first successful poll brings the document. From here on
			// the cadence rules decide the timer.
			hasBootstrapped = true;
			succeeded = true;
			nextDelay = boundedByQueuedWork( nextScheduledDelay() );
			if ( null !== nextDelay ) {
				pollInterval = nextDelay;
			}
		} catch ( error ) {
			// Whatever the cause, the probe's signals never arrived: back to
			// the outbox for the next carrier.
			probeFailed( payload.advisory?.seq );
			if (
				handleRequestFailure(
					error,
					payload,
					roomsInRequest,
					pollStarted
				)
			) {
				// Reset isPolling so a future registerRoom() call can
				// restart the loop.
				isPolling = false;
				return;
			}
		}

		if ( pollInFlightCounted ) {
			pollInFlightCounted = false;
			finishSend();
		}
		if ( repollImmediately ) {
			// A room restarted under us during this poll: the next poll
			// must follow at once (cursor 0) instead of waiting out the
			// interval.
			repollImmediately = false;
			scheduleNext( 0 );
			return;
		}
		scheduleNext( succeeded ? nextDelay : pollInterval );
	}

	// Start polling.
	void start();
}

/**
 * Handles a room whose generation changed mid-session: the server reset it
 * to a fresh genesis. The session decides whether it can rejoin (drop its
 * room-bound state and re-bootstrap from cursor 0) or must leave (its
 * local state cannot safely meet the new room); sessions without an
 * opinion re-bootstrap.
 *
 * Also used, with the generation unchanged, when the session finds that
 * it missed a row and has to read the room again from its first row.
 *
 * @param roomState  The room's transport state.
 * @param generation The new generation token.
 * @param updates    The rows the response carried for the new room.
 */
function restartRoom(
	roomState: RoomState,
	generation: string | undefined,
	updates: SyncUpdate[]
): void {
	const session = roomState.session as TransportSessionCodec;
	const previous = roomState.generation;
	let decision: 'rebootstrap' | 'disconnect' = 'rebootstrap';
	try {
		decision = session.onRoomRestart?.( updates ) ?? 'rebootstrap';
	} catch ( error ) {
		roomState.log(
			'Session failed to handle the room restart; disconnecting',
			{ error },
			'error',
			true // force
		);
		decision = 'disconnect';
	}
	roomState.log(
		previous === generation
			? 'Room read again from its first row (a row was missing)'
			: 'Room restarted by the server',
		{ from: previous, to: generation, decision },
		'error',
		true // force
	);

	if ( 'disconnect' === decision ) {
		roomState.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.UNKNOWN_ERROR,
				'The shared document was restarted by the server'
			),
		} );
		unregisterRoom( roomState.room, { sendDisconnectSignal: true } );
		return;
	}

	// The session dropped what it had not sent: that was made against
	// the old room. It works out what is still needed once the new room's
	// first document is in.
	roomState.generation = generation;
	roomState.endCursor = 0;
	repollImmediately = true;
}

function registerRoom( {
	room,
	session,
	log,
	onStatusChange,
	initialCursor = 0,
}: RegisterRoomOptions ): void {
	if ( roomStates.has( room ) ) {
		return;
	}

	// State accessors for the console inspector (duck-typed; inert unless
	// the inspector is enabled).
	registerDebugSession( room, session );

	/**
	 * Connection limits are enforced on the first entity to be loaded for sync.
	 * This is an inelegant solution to a hard problem: This sync provider and the
	 * sync package in general intentionally have no knowledge of the individual
	 * entities being synced.
	 *
	 * Let's say a user opens a document (Entity A) for editing. If you asked the
	 * user what they are doing, they would reply "I'm editing Entity A." You might
	 * say that Entity A is "primary."
	 *
	 * However, the action of editing Entity A also triggers the loading of a
	 * collection of document categories (Entity B) and another document (Entity C)
	 * that is embedded in Entity A. You might therefore say that Entity B and
	 * Entity C are "secondary" in this session.
	 *
	 * Meanwhile, a different user opens Entity C for editing, which also triggers
	 * the loading of Entity B. In this session, Entity C is "primary" and Entity B
	 * is "secondary."
	 *
	 * How do we enforce limits? The intuitive answer is that we only want to count
	 * connections when the entity is "primary." However, we have no ability to
	 * detect this. A document might be loaded as a primary entity in one session
	 * and a secondary entity in another.
	 *
	 * In practice, we can consider the first-loaded entity as "primary" and use it
	 * to enforce our connection limit. This is an imperfect assumption of consumer
	 * behavior.
	 *
	 * How might this approach be improved? We could develop some way to annotate
	 * entity loading so that the consumer can indicate which entity is primary.
	 */
	const isPrimaryRoom = 0 === roomStates.size;

	function onWorkWaiting( sizeInBytes: number ): void {
		if ( sizeInBytes > MAX_UPDATE_SIZE_IN_BYTES ) {
			const state = roomStates.get( room );
			if ( ! state ) {
				return;
			}

			state.log( 'Document size limit exceeded', {
				maxUpdateSizeInBytes: MAX_UPDATE_SIZE_IN_BYTES,
				updateSizeInBytes: sizeInBytes,
			} );

			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.DOCUMENT_SIZE_LIMIT_EXCEEDED,
					'Document size limit exceeded'
				),
			} );

			// This is an unrecoverable error. Unregister the room to prevent syncing.
			unregisterRoom( room );
			return;
		}

		wakeForLocalWork();
	}

	function unregister(): void {
		// Never drop unsent local work silently: give the session a
		// chance to tell the person before it is gone.
		if ( session.hasUpdatesToSend() ) {
			log(
				'Giving up a room that still has unsent sync updates',
				{},
				'error',
				true // force
			);
			( session as TransportSessionCodec ).onUpdatesDiscarded?.();
		}
		session.destroy();
	}

	const roomState: RoomState = {
		endCursor: initialCursor,
		isPrimaryRoom,
		lastServerAwareness: {},
		log,
		onStatusChange,
		room,
		session,
		unregister,
	};

	session.onWorkWaiting( onWorkWaiting );
	roomStates.set( room, roomState );

	if ( ! areListenersRegistered ) {
		window.addEventListener( 'beforeunload', handleBeforeUnload );
		window.addEventListener( 'pagehide', handlePageHide );
		document.addEventListener( 'visibilitychange', handleVisibilityChange );
		areListenersRegistered = true;
	}

	if ( isPrimaryRoom ) {
		fastDiscoveryUntil = Date.now() + FAST_DISCOVERY_WINDOW_MS;
		// The signaling lane and the advisory channel are per page, keyed
		// by the primary room's session (the post being edited).
		setSyncClientId( session.clientId );
		installAdvisoryHooks();
		startAdvisoryChannel();
	}

	if ( ! isPolling ) {
		poll();
	} else {
		// A room that arrives mid-session (an entity loaded later, or one
		// a socket handed over) needs its first poll promptly, whatever
		// the cadence rules have the timer at.
		if ( localUpdatePollTimer ) {
			return;
		}
		localUpdatePollTimer = setTimeout( () => {
			localUpdatePollTimer = null;
			pollNow();
		}, LOCAL_UPDATE_POLL_DELAY_MS );
	}
}

function unregisterRoom(
	room: string,
	{ sendDisconnectSignal = true }: { sendDisconnectSignal?: boolean } = {}
): void {
	const state = roomStates.get( room );
	if ( state ) {
		if ( sendDisconnectSignal ) {
			// Send a disconnect signal so the server removes this client's
			// awareness entry immediately instead of waiting for the timeout.
			const rooms = [
				{
					after: 0,
					awareness: null,
					client_id: state.session.clientId,
					room,
					updates: [],
				},
			];

			postSyncUpdateNonBlocking( { rooms } );
		}

		state.unregister();
		dropRoom( room );
		return;
	}
	unregisterDebugSession( room );
}

/**
 * Hands a room back to a preferred transport: waits for any request in
 * flight (so the cursor is final and nothing is delivered twice), then
 * drops the room WITHOUT destroying its session or telling the server it
 * left, returning the cursor to resume from. What the session has not
 * sent stays with the session.
 *
 * @param room The room.
 */
function releaseRoom( room: string ): Promise< ReleasedRoom > {
	const state = roomStates.get( room );
	if ( ! state ) {
		return Promise.resolve( { cursor: 0 } );
	}
	const finish = (): ReleasedRoom => {
		if ( roomStates.get( room ) !== state ) {
			return { cursor: 0 };
		}
		const released = { cursor: state.endCursor };
		dropRoom( room );
		return released;
	};
	const inFlight =
		isPolling && null === pollingTimeoutId && pollInFlightCounted;
	if ( ! inFlight ) {
		return Promise.resolve( finish() );
	}
	return new Promise< ReleasedRoom >( ( resolve ) => {
		sendDoneResolvers.push( {
			target: sendsStarted,
			resolve: () => resolve( finish() ),
		} );
	} );
}

/**
 * Removes a room from the loop and, when it was the last one, resets the
 * shared state. The session is left to the caller.
 *
 * @param room The room.
 */
function dropRoom( room: string ): void {
	roomStates.delete( room );
	unregisterDebugSession( room );

	if ( 0 === roomStates.size && areListenersRegistered ) {
		window.removeEventListener( 'beforeunload', handleBeforeUnload );
		window.removeEventListener( 'pagehide', handlePageHide );
		document.removeEventListener(
			'visibilitychange',
			handleVisibilityChange
		);
		areListenersRegistered = false;
		hasCheckedConnectionLimit = false;
		consecutiveFailures = 0;
		roomOverflowOffset = 0;
		syncRequestBodySizeLimit = MAX_SYNC_REQUEST_BODY_SIZE_IN_BYTES;
		hasBootstrapped = false;
		hasCollaborators = false;
		pollAgainRequested = false;
		cancelHiddenFlush();
		for ( const waiter of sendDoneResolvers.splice( 0 ) ) {
			waiter.resolve();
		}
		if ( localUpdatePollTimer ) {
			clearTimeout( localUpdatePollTimer );
			localUpdatePollTimer = null;
		}
		if ( announcePollTimer ) {
			clearTimeout( announcePollTimer );
			announcePollTimer = null;
		}
		stopAdvisoryChannel();
	}
}

/**
 * Immediately retry the sync connection by cancelling any pending
 * timeout and triggering a new poll. If the retry fails, the next
 * auto-retry waits 15s (MANUAL_RETRY_INTERVAL_MS) instead of the
 * usual 30s, then falls back to 30s for subsequent auto-retries.
 */
function retryNow(): void {
	isManualRetry = true;
	pollNow();
}

export const pollingManager: PollingManager = {
	registerRoom,
	releaseRoom,
	retryNow,
	unregisterRoom,
};
