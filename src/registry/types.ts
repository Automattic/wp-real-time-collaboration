/**
 * The types an engine and a transport share.
 *
 * An engine owns what an update means. A transport owns how updates move:
 * rooms, cursors, timing, connection status. The two meet in one object,
 * the session, which the engine creates for each room and hands to the
 * transport. The transport asks the session for updates to send and gives
 * it the updates it receives, and never looks inside one.
 *
 * Nothing here may name one engine's own types. The same transport must be
 * able to carry any engine's updates.
 */

/**
 * Internal dependencies
 */
import type { ConnectionError } from './connection-error';

/** An entity type as a room names it, for example `postType/post`. */
export type ObjectType = string;

/** An entity id as a room names it. */
export type ObjectID = string;

/**
 * This tab's presence state as sent to the server, or null when the tab is
 * leaving.
 */
export type LocalAwarenessState = object | null;

/**
 * The presence states of every tab in a room, keyed by client id, as the
 * server returns them.
 */
export type AwarenessState = Record< string, LocalAwarenessState >;

/**
 * One update as it travels: a kind the engine defines, and its payload.
 * Transports move these without reading them.
 */
export interface EngineUpdate {
	/** The payload. Transports do not read it. */
	data: string;
	/** The kind of update, a value the engine defines. */
	type: string;
}

/**
 * The server's answer for one update this tab sent.
 */
export interface EngineDisposition {
	/**
	 * The id the engine gave the update. Missing when the server could
	 * not read an id from the update. `row` then names the update.
	 */
	intentId?: string;
	/**
	 * The update's place in the request, counted from 0. Set only when
	 * the update has no id the server could read.
	 */
	row?: number;
	/** The outcome, a value the engine defines, for example `applied`. */
	status: string;
	/** Why, for an outcome other than applied. */
	reason?: string;
}

/**
 * One room's session, as a transport sees it. The engine creates it and
 * keeps its own state behind it.
 */
export interface EngineSessionCodec {
	/** Applies presence states received from the server. */
	applyRemoteAwareness: ( state: AwarenessState ) => void;

	/** The client id this session announces to the server. */
	clientId: number;

	/**
	 * The engine's name and protocol version, sent with every request so
	 * the server can refuse a tab that speaks another engine before it
	 * stores anything.
	 */
	engineSlug?: string;
	engineProtocol?: number;

	/**
	 * Detaches the listener registered with `onWorkWaiting`. Safe to call
	 * more than once. A later `onWorkWaiting` call attaches again.
	 */
	destroy: () => void;

	/** This tab's presence state for the next request. */
	getLocalAwareness: () => LocalAwarenessState;

	/**
	 * Subscribes to "an update can be sent now", replacing any earlier
	 * listener. The listener gets the byte length of the update's data,
	 * so a transport can enforce a size limit. The session keeps the
	 * update. The transport asks for it with `takeUpdatesToSend`.
	 */
	onWorkWaiting: ( listener: ( dataSize: number ) => void ) => void;

	/** Whether `takeUpdatesToSend` would return anything. */
	hasUpdatesToSend: () => boolean;

	/**
	 * The updates to send now, oldest first, within a size budget. An
	 * update counts as the byte length of its JSON form plus one. The
	 * updates are on their way from this call on, and are not handed out
	 * again unless `connectionLost` is called. The session holds all
	 * unsent work. A transport keeps no queue.
	 */
	takeUpdatesToSend: ( limit: { maxBytes: number } ) => EngineUpdate[];

	/**
	 * Tells the session that the updates on their way may not have
	 * arrived: a request failed, a socket closed, or another transport
	 * takes the room. They are handed out again. The server must accept
	 * an update it has already.
	 */
	connectionLost: () => void;

	/**
	 * Takes the updates of one answer, in order.
	 */
	receiveUpdates: ( updates: EngineUpdate[] ) => void;

	/**
	 * Takes the server's answers for a batch this tab sent. A transport
	 * must call this after it has passed on the updates of the same
	 * response, so the session's document never goes backwards.
	 */
	receiveDispositions?: ( dispositions: EngineDisposition[] ) => void;

	/**
	 * Receives the room's newest position (`seq` in the room's answer),
	 * which the server sends when the request stored updates. Called
	 * after the answer's updates and dispositions.
	 */
	receiveHeadSeq?: ( seq: number ) => void;

	/**
	 * Asked after each answer was applied: whether the session found
	 * that it missed an update and must read the room again from its
	 * first row. A true answer is given once. The transport then starts
	 * the room over, as it does when the server restarted the room.
	 */
	takeRestartRequest?: () => boolean;
}

export interface ConnectionStatusConnected {
	status: 'connected';
}

export interface ConnectionStatusConnecting {
	status: 'connecting';
}

export interface ConnectionStatusDisconnected {
	status: 'disconnected';

	/** What went wrong, when known. */
	error?: ConnectionError;

	/** Whether the person can retry by hand. */
	canManuallyRetry?: boolean;

	/** Failed requests in a row since the last good connection. */
	consecutiveFailures?: number;

	/** Whether the automatic retries have all been used up. */
	backgroundRetriesFailed?: boolean;

	/** Milliseconds until the next automatic retry. */
	willAutoRetryInMs?: number;
}

/** The connection status of one room on one transport. */
export type ConnectionStatus =
	| ConnectionStatusConnected
	| ConnectionStatusConnecting
	| ConnectionStatusDisconnected;

/** The events a transport's room connection reports. */
export interface ProviderEventMap {
	status: ConnectionStatus;
}

export type ProviderOn = < K extends keyof ProviderEventMap >(
	event: K,
	callback: ( data: ProviderEventMap[ K ] ) => void
) => void;

/** One room's connection, as a transport returns it. */
export interface ProviderCreatorResult {
	destroy: () => void;
	on: ProviderOn;

	/** Connects or polls again at once, after a connection error. */
	retry?: () => void;
}

/** What a transport gets when it is asked to connect a room. */
export interface ProviderCreatorOptions {
	objectType: ObjectType;
	objectId: ObjectID | null;
	session: EngineSessionCodec;
}

/** Connects one room on a transport. */
export type ProviderCreator = (
	options: ProviderCreatorOptions
) => Promise< ProviderCreatorResult >;

/** Whether an undo history has steps to undo and to redo. */
export interface SyncUndoStackState {
	hasRedo: boolean;
	hasUndo: boolean;
}

/** An entity record, or a part of one. */
export type ObjectData = Record< string, unknown >;

/** One entity's changes inside an undo step, as core-data records them. */
export interface UndoHistoryChanges {
	id: string | Record< string, unknown >;
	changes: Record< string, { from: ObjectData; to: ObjectData } >;
}

/**
 * The undo manager shape core-data expects from an engine that keeps its
 * own undo history.
 */
export interface SyncUndoManager {
	addRecord: ( record?: UndoHistoryChanges[], isStaged?: boolean ) => void;
	undo: () => UndoHistoryChanges[] | undefined;
	redo: () => UndoHistoryChanges[] | undefined;
	hasUndo: () => boolean;
	hasRedo: () => boolean;

	/** Closes the current undo step, so the next change opens a new one. */
	stopCapturing: () => void;

	/**
	 * Part of the shape for engines built on a Yjs document. An engine
	 * without one leaves it empty.
	 */
	addToScope: () => void;
}
