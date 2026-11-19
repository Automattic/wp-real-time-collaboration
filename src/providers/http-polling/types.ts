/**
 * Internal dependencies
 */
import type {
	AwarenessState,
	EngineDisposition,
	EngineUpdate,
	LocalAwarenessState,
} from '../../registry/types';

export type { AwarenessState, LocalAwarenessState };

/**
 * An update on the wire. The transport does not read its `type` or its
 * `data`. The engine defines both.
 */
export type SyncUpdate = EngineUpdate;

interface SyncEnvelopeFromClient {
	after: number;
	awareness: LocalAwarenessState;
	client_id: number;
	/**
	 * Engine identity stamp (see EngineSessionCodec.engineSlug): lets the
	 * server fence a stale tab speaking the wrong engine with a 409 before
	 * storing any of its updates.
	 */
	engine?: string;
	engine_protocol?: number;
	/** Sync-inspector opt-in: ask the engine for a `_debug` envelope. */
	debug?: boolean;
	/**
	 * This tab's presence token on its post's room: the tab's first request
	 * carrying it is its join, which under the default unsaved-changes
	 * policy resets a per-post room nobody else is in to the saved post.
	 */
	presence_token?: string;
	room: string;
	updates: SyncUpdate[];
}

interface SyncEnvelopeFromServer {
	/** Engine diagnostics, present only when the request opted in. */
	_debug?: Record< string, unknown >;
	awareness: AwarenessState;
	dispositions?: EngineDisposition[];
	end_cursor: number; // use as `after` in next request
	/**
	 * The room's generation token: changes whenever the server restarts
	 * the room (resets it to a fresh genesis). A client that sees a
	 * different value from the one it bootstrapped under must drop its
	 * room-bound state and start over from cursor 0.
	 */
	generation?: string;
	/**
	 * The room's newest position, sent when the request stored updates.
	 * The engine defines what it counts.
	 */
	seq?: number;
	room: string;
	updates: SyncUpdate[];
}

export interface SyncPayload {
	rooms: SyncEnvelopeFromClient[];
	/**
	 * The advisory channel's signaling probe (per-tab token and queued
	 * handshake messages; see providers/advisory/signaling.ts). Answered
	 * alongside the rooms: an active poll loop is a faster carrier than
	 * the heartbeat.
	 */
	advisory?: Record< string, unknown > & { seq?: number };
}

export interface SyncResponse {
	rooms: SyncEnvelopeFromServer[];
	/** The server's answer to the request's advisory probe, when sent. */
	advisory?: unknown;
}
