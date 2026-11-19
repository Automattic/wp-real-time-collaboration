/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/**
 * Internal dependencies
 */
import type {
	AwarenessState,
	ConnectionStatus,
	EngineSessionCodec,
	EngineUpdate,
} from '../../registry/types';
import {
	ConnectionError,
	ConnectionErrorCode,
} from '../../registry/connection-error';
import type { TransportSessionCodec } from '../session-extensions';
import {
	installSyncDebug,
	isSyncDebugEnabled,
	recordPoll,
	registerDebugSession,
	unregisterDebugSession,
} from '../../debug/inspector';
import { pollingManager } from '../http-polling/polling-manager';
import { getClientLimitPerRoom } from '../connection-limit';
import {
	getPresenceRoom,
	getPresenceToken,
	installSignalingLifecycle,
	setSyncClientId,
} from '../advisory/signaling';

/**
 * A codec-driven WebSocket transport, symmetric with the HTTP polling
 * manager but PUSH-based: one shared socket carries every room, the server
 * pushes peers' updates the instant they arrive, and the client speaks the
 * same room-request/room-response shape the REST endpoints use (wrapped in a
 * `{type:'sync'}` frame). The transport never interprets update payloads —
 * it moves the engine session codec's opaque updates and awareness, exactly
 * like the polling transport.
 *
 * The socket is authenticated with a one-time token minted over REST
 * (`/wp-sync/v1/ws-token`); the daemon validates it against the logged-in
 * cookie on handshake.
 *
 * A PREFERRED TRANSPORT (docs/transports.md): the socket
 * carries everything while it is open, and short polling, the base
 * transport, is the fallback whenever it is not — the daemon unreachable, the token
 * refused, the socket dropped. A room the socket cannot serve is PARKED
 * with the polling manager at the cursor the socket had reached; when the
 * socket (re)opens, the room is reclaimed at the cursor polling reached.
 * Rows are therefore delivered by exactly one lane at a time and never
 * replayed across the handoff.
 *
 * Neither lane keeps a queue. The session holds every update the server
 * has not answered, and whichever lane serves the room asks it what to
 * send. When a socket closes, the session is told, and the updates that
 * were on their way go out again on the next lane.
 */

const WS_TOKEN_API_PATH = '/wp-sync/v1/ws-token';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// A connection attempt that has not opened by then hands the rooms to
// short polling while it keeps trying (a black-holed port can take the
// browser tens of seconds to give up on; a refused one fails at once).
const CONNECT_ATTEMPT_MS = 5000;
const AWARENESS_INTERVAL_MS = 10000;

interface RoomState {
	room: string;
	isPrimaryRoom: boolean;
	session: EngineSessionCodec;
	cursor: number;
	/** The room generation this session bootstrapped under. */
	generation?: string;
	onStatusChange: ( status: ConnectionStatus ) => void;
	/** Whether short polling currently serves this room (socket down). */
	parked: boolean;
}

interface ServerRoom {
	room: string;
	awareness: AwarenessState;
	updates: EngineUpdate[];
	end_cursor: number;
	/** Changes whenever the server restarts the room (fresh genesis). */
	generation?: string;
	dispositions?: unknown[];
	/** The room's newest position, sent when the request stored updates. */
	seq?: number;
}

const rooms = new Map< string, RoomState >();

// Console stub for the sync inspector (wpSync.enable() and friends).
installSyncDebug();

let socket: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType< typeof setTimeout > | null = null;
let awarenessTimer: ReturnType< typeof setInterval > | null = null;
let connecting = false;
let connectAttemptTimer: ReturnType< typeof setTimeout > | null = null;
let hasCheckedConnectionLimit = false;

function clearConnectAttemptTimer(): void {
	if ( connectAttemptTimer ) {
		clearTimeout( connectAttemptTimer );
		connectAttemptTimer = null;
	}
}

/**
 * Fetches a one-time WebSocket token.
 *
 * @return {Promise<string>} The token.
 */
async function fetchToken(): Promise< string > {
	const response = ( await apiFetch( {
		method: 'POST',
		path: WS_TOKEN_API_PATH,
	} ) ) as { token?: string };
	if ( ! response?.token ) {
		throw new Error( 'Invalid ws-token response' );
	}
	return response.token;
}

/**
 * The announced socket URL. The one-time token deliberately does NOT
 * ride the URL (query strings land in server and proxy access logs);
 * it travels as a Sec-WebSocket-Protocol offer instead — the one
 * handshake header a browser page can influence.
 *
 * @return {string} Socket URL.
 */
function socketUrl(): string {
	const base = announcedSocketUrl();
	if ( ! base ) {
		throw new Error( 'WebSocket URL is not configured' );
	}
	return base;
}

/**
 * The socket address the server printed, or an empty string. The server
 * prints none when the site has no sync daemon address set. WebSocket is
 * the default transport and most sites run no daemon, so this is the
 * usual case there: the rooms stay on polling, and no token is asked for.
 *
 * @return The address, or an empty string.
 */
function announcedSocketUrl(): string {
	// Announced through the framework's `wp_sync_transport_client_config`
	// filter (hooked by this plugin's PHP half).
	const transportConfig = (
		window as Window & {
			_wpCollaborationTransportConfig?: {
				websocket?: { url?: string };
			};
		}
	 )._wpCollaborationTransportConfig;
	return transportConfig?.websocket?.url ?? '';
}

/**
 * Builds the sync frame for a set of rooms, optionally carrying each room's
 * queued local update.
 *
 * @param {Map<string, EngineUpdate[]>} pending Per-room updates to send.
 * @return {string} JSON frame.
 */
function buildSyncFrame( pending: Map< string, EngineUpdate[] > ): string {
	const payloadRooms = [];
	for ( const state of rooms.values() ) {
		payloadRooms.push( {
			after: state.cursor,
			awareness: state.session.getLocalAwareness(),
			client_id: state.session.clientId,
			room: state.room,
			updates: pending.get( state.room ) ?? [],
			...( state.session.engineSlug
				? {
						engine: state.session.engineSlug,
						engine_protocol: state.session.engineProtocol,
				  }
				: {} ),
			// This tab's presence token, on its post's room only (see the
			// polling manager's twin).
			...( getPresenceRoom() === state.room && getPresenceToken()
				? { presence_token: getPresenceToken()! }
				: {} ),
			// The inspector's server-envelope opt-in (see debug/inspector.ts).
			...( isSyncDebugEnabled() ? { debug: true } : {} ),
		} );
	}
	return JSON.stringify( { type: 'sync', rooms: payloadRooms } );
}

/**
 * Sends a frame carrying the given per-room updates, feeding the inspector's
 * wire tap. The socket is push-based, so sends and receives are recorded as
 * separate one-directional entries (unlike the polling transport's paired
 * request/response records).
 *
 * @param {Map<string, EngineUpdate[]>} pending Per-room updates to send.
 */
function sendFrame( pending: Map< string, EngineUpdate[] > ): void {
	if ( ! socket || WebSocket.OPEN !== socket.readyState ) {
		return;
	}
	socket.send( buildSyncFrame( pending ) );
	if ( ! isSyncDebugEnabled() ) {
		return;
	}
	for ( const [ room, updates ] of pending ) {
		recordPoll( {
			room,
			sent: updates,
			received: [],
			cursorBefore: rooms.get( room )?.cursor,
		} );
	}
}

/**
 * Sends what a room's session has waiting over the socket, or opens the
 * socket first. The first frame on a new socket carries it then.
 *
 * @param state The room.
 */
function sendWaiting( state: RoomState ): void {
	if ( ! socket || WebSocket.OPEN !== socket.readyState ) {
		connect();
		return;
	}

	const updates = state.session.takeUpdatesToSend( {
		maxBytes: Infinity,
	} );

	if ( updates.length > 0 ) {
		sendFrame( new Map( [ [ state.room, updates ] ] ) );
	}
}

/**
 * Test/diagnostic observability: mirrors the socket and per-room sync
 * state onto a window global, the way the retired test WS provider
 * exposed `__gutenbergTestWebSocketSync`. The websocket lane has no HTTP
 * responses to await, so the e2e fixtures (and humans in devtools) read
 * this instead. Cheap: a plain object rebuilt on lifecycle edges.
 */
function publishDebugState(): void {
	const roomsState: Record< string, { synced: boolean } > = {};
	for ( const state of rooms.values() ) {
		roomsState[ state.room ] = { synced: state.cursor > 0 };
	}
	(
		window as Window & {
			__wpSyncWsState?: {
				open: boolean;
				rooms: typeof roomsState;
				parked: string[];
			};
		}
	 ).__wpSyncWsState = {
		open: !! socket && WebSocket.OPEN === socket.readyState,
		rooms: roomsState,
		parked: Array.from( rooms.values() )
			.filter( ( state ) => state.parked )
			.map( ( state ) => state.room ),
	};
}

/**
 * Applies a server room response to its room's codec.
 *
 * @param serverRoom One room's response.
 */
function applyServerRoom( serverRoom: ServerRoom ): void {
	const state = rooms.get( serverRoom.room );
	if ( ! state ) {
		return;
	}
	// Match polling: check the first room's initial response only.
	// Awareness includes this editor, so five means five total peers.
	if ( state.isPrimaryRoom && ! hasCheckedConnectionLimit ) {
		hasCheckedConnectionLimit = true;
		if (
			Object.keys( serverRoom.awareness ).length >
			getClientLimitPerRoom( state.room )
		) {
			state.onStatusChange( {
				status: 'disconnected',
				error: new ConnectionError(
					ConnectionErrorCode.CONNECTION_LIMIT_EXCEEDED,
					'Connection limit exceeded'
				),
			} );
			unregisterRoom( state.room );
			return;
		}
	}

	// The inspector's wire tap: pushed traffic, decoded.
	if ( isSyncDebugEnabled() ) {
		recordPoll( {
			room: serverRoom.room,
			sent: [],
			received: serverRoom.updates ?? [],
			dispositions: serverRoom.dispositions as
				| Array< Record< string, unknown > >
				| undefined,
			cursorBefore: state.cursor,
			cursorAfter: serverRoom.end_cursor,
			serverDebug: (
				serverRoom as {
					_debug?: Record< string, unknown >;
				}
			 )._debug,
		} );
	}

	/*
	 * Room generation: a changed token means the server reset the room to
	 * a fresh genesis. The session decides whether it can re-bootstrap
	 * (cursor 0, initial sync re-sent) or must leave; the rows in this
	 * frame belong to the new room and are re-delivered from cursor 0.
	 */
	if ( 'string' === typeof serverRoom.generation ) {
		if ( undefined === state.generation ) {
			state.generation = serverRoom.generation;
		} else if ( state.generation !== serverRoom.generation ) {
			restartRoom(
				state,
				serverRoom.generation,
				serverRoom.updates ?? []
			);
			return;
		}
	}

	state.session.applyRemoteAwareness( serverRoom.awareness );

	try {
		state.session.receiveUpdates( serverRoom.updates ?? [] );
	} catch {
		// A malformed update must not tear down the socket.
	}
	if ( serverRoom.dispositions && state.session.receiveDispositions ) {
		state.session.receiveDispositions( serverRoom.dispositions as never );
	}
	state.cursor = serverRoom.end_cursor;
	publishDebugState();

	if ( 'number' === typeof serverRoom.seq ) {
		state.session.receiveHeadSeq?.( serverRoom.seq );
	}

	// The session found that it missed a row: read the room again from
	// its first row, as after a restart of the room by the server.
	if ( state.session.takeRestartRequest?.() ) {
		restartRoom( state, state.generation, [] );
	}
}

/**
 * Handles a room whose generation changed: see the polling manager's twin.
 * Re-bootstrapping re-sends the room's initial sync at cursor 0 so the
 * daemon delivers the new room from its genesis.
 *
 * @param state      The room's state.
 * @param generation The new generation token.
 * @param updates    The rows the frame carried for the new room.
 */
function restartRoom(
	state: RoomState,
	generation: string | undefined,
	updates: EngineUpdate[]
): void {
	const session = state.session as TransportSessionCodec;
	let decision: 'rebootstrap' | 'disconnect' = 'rebootstrap';
	try {
		decision = session.onRoomRestart?.( updates ) ?? 'rebootstrap';
	} catch {
		decision = 'disconnect';
	}
	if ( 'disconnect' === decision ) {
		state.onStatusChange( {
			status: 'disconnected',
			error: new ConnectionError(
				ConnectionErrorCode.UNKNOWN_ERROR,
				'The shared document was restarted by the server'
			),
		} );
		unregisterRoom( state.room );
		return;
	}
	state.generation = generation;
	state.cursor = 0;
	publishDebugState();
	// Ask for the room again from its first row.
	sendFrame( new Map( [ [ state.room, [] ] ] ) );
}

/**
 * Handles an incoming socket frame.
 *
 * @param {MessageEvent} event Socket message.
 */
function onMessage( event: MessageEvent ): void {
	let parsed: { type?: string; rooms?: ServerRoom[] };
	try {
		parsed = JSON.parse( String( event.data ) );
	} catch {
		return;
	}
	if ( 'sync' !== parsed.type || ! Array.isArray( parsed.rooms ) ) {
		return;
	}
	for ( const serverRoom of parsed.rooms ) {
		applyServerRoom( serverRoom );
	}
}

/**
 * Sends the first frame on a new socket: every room, each with what its
 * session has waiting.
 */
function sendInitialSync(): void {
	if ( ! socket || WebSocket.OPEN !== socket.readyState ) {
		return;
	}
	const pending = new Map< string, EngineUpdate[] >();
	for ( const state of rooms.values() ) {
		pending.set(
			state.room,
			state.session.takeUpdatesToSend( { maxBytes: Infinity } )
		);
	}
	sendFrame( pending );
}

/**
 * Makes the socket the one that hears when a room has something to send
 * (the polling manager takes that over while it serves the room).
 *
 * @param state The room.
 */
function bindLocalUpdates( state: RoomState ): void {
	state.session.onWorkWaiting( () => sendWaiting( state ) );
}

function log(
	message: string,
	debug: object = {},
	errorLevel: 'log' | 'warn' | 'error' = 'log',
	force = false
): void {
	if ( ! force ) {
		return;
	}
	// eslint-disable-next-line no-console
	( console[ errorLevel ] || console.log )(
		`[WebSocketManager]: ${ message }`,
		debug
	);
}

/**
 * The socket cannot serve the rooms: park each one with short polling at
 * the cursor the socket had reached. Idempotent per room.
 */
function parkRooms(): void {
	for ( const state of rooms.values() ) {
		if ( state.parked ) {
			continue;
		}
		state.parked = true;
		// Whatever the socket carried and the server did not answer goes
		// out again, over polling. The socket stops listening first, so
		// that this does not make it reconnect at once.
		state.session.onWorkWaiting( () => {} );
		state.session.connectionLost();
		pollingManager.registerRoom( {
			room: state.room,
			session: state.session,
			log,
			onStatusChange: state.onStatusChange,
			initialCursor: state.cursor,
		} );
	}
	publishDebugState();
}

function hasParkedRooms(): boolean {
	for ( const state of rooms.values() ) {
		if ( state.parked ) {
			return true;
		}
	}
	return false;
}

/**
 * The socket is open again: take every parked room back from short
 * polling at the cursor polling reached. Resolves once the rooms are the
 * socket's again.
 *
 * @param opened The socket that opened.
 */
async function reclaimRooms( opened: WebSocket ): Promise< void > {
	const parked = Array.from( rooms.values() ).filter(
		( state ) => state.parked
	);
	await Promise.all(
		parked.map( async ( state ) => {
			const released = await pollingManager.releaseRoom( state.room );
			if ( rooms.get( state.room ) !== state ) {
				return; // Unregistered meanwhile.
			}
			state.cursor = Math.max( state.cursor, released.cursor );
			if ( socket !== opened || WebSocket.OPEN !== opened.readyState ) {
				// The socket died while polling finished its request: the
				// room stays parked, back with polling at the cursor it
				// reached.
				pollingManager.registerRoom( {
					room: state.room,
					session: state.session,
					log,
					onStatusChange: state.onStatusChange,
					initialCursor: state.cursor,
				} );
				return;
			}
			state.parked = false;
			bindLocalUpdates( state );
			registerDebugSession( state.room, state.session );
		} )
	);
	publishDebugState();
}

/**
 * Periodically pushes local awareness so peers see presence and the server
 * keeps this client's entry fresh.
 */
function sendAwareness(): void {
	if (
		! socket ||
		WebSocket.OPEN !== socket.readyState ||
		0 === rooms.size
	) {
		return;
	}
	sendFrame( new Map() );
}

/**
 * Opens (or reuses) the shared socket.
 */
function connect(): void {
	if ( connecting || 0 === rooms.size ) {
		return;
	}
	if ( socket && WebSocket.OPEN === socket.readyState ) {
		return;
	}
	if ( ! announcedSocketUrl() ) {
		// No daemon address: polling serves the rooms, for good. No
		// token request, and nothing to try again later.
		parkRooms();
		return;
	}
	connecting = true;
	rooms.forEach( ( state ) =>
		state.onStatusChange( { status: 'connecting' } )
	);
	clearConnectAttemptTimer();
	connectAttemptTimer = setTimeout( () => {
		connectAttemptTimer = null;
		if ( connecting ) {
			parkRooms();
		}
	}, CONNECT_ATTEMPT_MS );

	fetchToken()
		.then( ( token ) => {
			// The token rides the subprotocol offer list, never the URL:
			// the daemon consumes the `wp-sync-token.<hex>` offer and
			// echoes the base `wp-sync` protocol on accept.
			socket = new window.WebSocket( socketUrl(), [
				'wp-sync',
				`wp-sync-token.${ token }`,
			] );
			socket.addEventListener( 'open', () => {
				const opened = socket;
				publishDebugState();
				connecting = false;
				clearConnectAttemptTimer();
				reconnectAttempts = 0;
				const proceed = () => {
					if ( socket !== opened ) {
						return; // Closed again meanwhile.
					}
					rooms.forEach( ( state ) =>
						state.onStatusChange( { status: 'connected' } )
					);
					sendInitialSync();
					if ( ! awarenessTimer ) {
						awarenessTimer = setInterval(
							sendAwareness,
							AWARENESS_INTERVAL_MS
						);
					}
				};
				// Reclaim parked rooms from short polling first, so the
				// initial sync resumes at the cursor polling reached.
				if ( hasParkedRooms() ) {
					void reclaimRooms( opened! ).then( proceed );
				} else {
					proceed();
				}
			} );
			socket.addEventListener( 'message', onMessage );
			socket.addEventListener( 'close', onClose );
			socket.addEventListener( 'error', () => socket?.close() );
		} )
		.catch( () => {
			connecting = false;
			clearConnectAttemptTimer();
			parkRooms();
			scheduleReconnect();
		} );
}

/**
 * Handles socket close: mark disconnected and schedule a reconnect while any
 * room is still registered.
 */
function onClose(): void {
	publishDebugState();
	connecting = false;
	clearConnectAttemptTimer();
	socket = null;
	if ( awarenessTimer ) {
		clearInterval( awarenessTimer );
		awarenessTimer = null;
	}
	if ( rooms.size > 0 ) {
		// Short polling takes over at once (its own status events follow);
		// the socket keeps trying in the background.
		parkRooms();
		scheduleReconnect();
	}
}

/**
 * Schedules a reconnect with exponential backoff.
 */
function scheduleReconnect(): void {
	if ( reconnectTimer || 0 === rooms.size ) {
		return;
	}
	const delay = Math.min(
		RECONNECT_MAX_MS,
		RECONNECT_BASE_MS * 2 ** reconnectAttempts
	);
	reconnectAttempts++;
	reconnectTimer = setTimeout( () => {
		reconnectTimer = null;
		connect();
	}, delay );
}

export interface WebSocketRoomOptions {
	room: string;
	session: EngineSessionCodec;
	onStatusChange: ( status: ConnectionStatus ) => void;
}

export interface WebSocketManager {
	registerRoom: ( options: WebSocketRoomOptions ) => void;
	unregisterRoom: ( room: string ) => void;
}

/**
 * Registers a room: track it, forward its local updates to the socket, and
 * ensure the socket is open.
 *
 * @param {WebSocketRoomOptions} options Room options.
 */
function registerRoom( options: WebSocketRoomOptions ): void {
	const state: RoomState = {
		room: options.room,
		isPrimaryRoom: rooms.size === 0,
		session: options.session,
		cursor: 0,
		onStatusChange: options.onStatusChange,
		parked: false,
	};
	rooms.set( options.room, state );
	bindLocalUpdates( state );

	// The leave beacon and this post's session client id, so the server
	// can tell this tab's own awareness entry apart from a peer's when it
	// leaves (see the polling manager's twin).
	installSignalingLifecycle();
	if ( getPresenceRoom() === options.room ) {
		setSyncClientId( options.session.clientId );
	}

	// State accessors for the console inspector (duck-typed; inert unless
	// the inspector is enabled).
	registerDebugSession( options.room, options.session );

	if ( socket && WebSocket.OPEN === socket.readyState ) {
		// Socket already open: ask for this room now, with what its
		// session has waiting.
		sendFrame(
			new Map( [
				[
					options.room,
					options.session.takeUpdatesToSend( {
						maxBytes: Infinity,
					} ),
				],
			] )
		);
	} else if ( socket || connecting ) {
		// A connection attempt is under way; the room joins its outcome.
	} else if ( reconnectTimer ) {
		// The socket is down and a retry is pending: park with polling now.
		parkRooms();
	} else {
		connect();
	}
}

/**
 * Unregisters a room; closes the socket when the last room leaves.
 *
 * @param {string} room Room identifier.
 */
function unregisterRoom( room: string ): void {
	const state = rooms.get( room );
	if ( state ) {
		rooms.delete( room );
		if ( state.parked ) {
			// Polling owns the session: its teardown destroys it.
			pollingManager.unregisterRoom( room );
		} else {
			state.session.destroy();
		}
	}
	unregisterDebugSession( room );
	if ( 0 === rooms.size ) {
		if ( reconnectTimer ) {
			clearTimeout( reconnectTimer );
			reconnectTimer = null;
		}
		if ( awarenessTimer ) {
			clearInterval( awarenessTimer );
			awarenessTimer = null;
		}
		clearConnectAttemptTimer();
		socket?.close();
		socket = null;
	}
}

export const websocketManager: WebSocketManager = {
	registerRoom,
	unregisterRoom,
};

/**
 * Resets the module state. Test use only.
 */
export function resetWebSocketManagerForTesting(): void {
	rooms.clear();
	hasCheckedConnectionLimit = false;
	if ( reconnectTimer ) {
		clearTimeout( reconnectTimer );
		reconnectTimer = null;
	}
	if ( awarenessTimer ) {
		clearInterval( awarenessTimer );
		awarenessTimer = null;
	}
	socket = null;
	connecting = false;
	clearConnectAttemptTimer();
	reconnectAttempts = 0;
}
