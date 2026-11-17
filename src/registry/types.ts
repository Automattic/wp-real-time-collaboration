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
 * Called for each update a local edit produces. The size lets a transport
 * enforce a size limit without decoding the payload.
 */
export type EngineLocalUpdateListener = (
	update: EngineUpdate,
	sizeInBytes: number
) => void;

/**
 * The server's answer for one update this tab sent.
 */
export interface EngineDisposition {
	/** The id the engine gave the update. */
	intentId: string;
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
	 * Creates one update that holds the full local state and replaces all
	 * earlier ones. Optional. The intent-log engine does not use it.
	 */
	createCompactionUpdate?: () => EngineUpdate;

	/**
	 * Creates the update to send after a request whose outcome is unknown.
	 * Only an engine whose updates cannot safely be sent twice needs it.
	 * Without it the transport sends the same updates again.
	 */
	createRecoveryUpdate?: () => EngineUpdate;

	/**
	 * Merges updates the server handed back into one. Optional and unused.
	 *
	 * @deprecated No server asks for this any more.
	 */
	createCompactionFromUpdates?: ( updates: EngineUpdate[] ) => EngineUpdate;

	/**
	 * Detaches the listener registered with `onLocalUpdate`. Safe to call
	 * more than once. A later `onLocalUpdate` call attaches again.
	 */
	destroy: () => void;

	/** The updates that announce this session to a room it just joined. */
	getInitialUpdates: () => EngineUpdate[];

	/** This tab's presence state for the next request. */
	getLocalAwareness: () => LocalAwarenessState;

	/**
	 * Subscribes to updates produced by local edits, replacing any earlier
	 * listener. Updates applied through `receiveUpdate` are not reported.
	 */
	onLocalUpdate: ( listener: EngineLocalUpdateListener ) => void;

	/**
	 * Takes one received update. May return an update to send in answer.
	 */
	receiveUpdate: ( update: EngineUpdate ) => EngineUpdate | void;

	/**
	 * Takes the server's answers for a batch this tab sent. A transport
	 * must call this after it has passed on the updates of the same
	 * response, so the session's document never goes backwards.
	 */
	receiveDispositions?: ( dispositions: EngineDisposition[] ) => void;
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
