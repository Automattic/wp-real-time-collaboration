/**
 * Everything this plugin relies on from Gutenberg that is not a public,
 * documented API. When Gutenberg changes, the damage shows here first.
 *
 * So far this file holds the presence object. More of the contract moves
 * here as the plugin stops reaching into Gutenberg from other files.
 */

/**
 * Internal dependencies
 */
import type { ConnectionStatus } from '../registry/types';

/**
 * One change to who is present: the client ids that appeared, changed, and
 * left.
 */
export interface PresenceChange {
	added: number[];
	updated: number[];
	removed: number[];
}

/**
 * The presence object core-data builds for a synced record, through the
 * record's `syncConfig.createAwareness`. It shows who else is editing.
 *
 * Underneath it is an `Awareness` instance from the `y-protocols` package,
 * which core-data bundles. The plugin never imports that package. It uses
 * only the members listed here.
 */
export interface PresenceObject {
	/*
	 * Public members of the Awareness class.
	 */

	/** This tab's client id. */
	clientID: number;

	/** This tab's own presence state. */
	getLocalState: () => Record< string, unknown > | null;

	/** Sets one field of this tab's presence state and tells listeners. */
	setLocalStateField: ( field: string, value: unknown ) => void;

	/**
	 * Every known presence state, keyed by client id. This is the live map
	 * the object keeps, not a copy.
	 */
	getStates: () => Map< number, object >;

	/** Stops the object and tells its listeners. */
	destroy?: () => void;

	/*
	 * Internal uses. Each one reaches past what the Awareness class means
	 * other code to touch, so each one can break when core-data changes
	 * how it builds or bundles the object.
	 */

	/**
	 * The plugin writes other tabs' states straight into the map that
	 * `getStates()` returns, and deletes from it. The class has no public
	 * way to set another client's state from plain data.
	 * Used in: src/awareness/awareness-sync.ts.
	 */

	/**
	 * A clock per client id. The plugin moves this tab's own clock forward
	 * when the server's list drops this tab, as the class does itself.
	 * Used in: src/awareness/awareness-sync.ts.
	 */
	meta: Map< number, { clock: number; lastUpdated: number } >;

	/**
	 * The event method the class inherits. The plugin calls it after it
	 * has changed the map by hand, so the editor's presence display
	 * updates. `change` is for a visible change, `update` for any.
	 * Used in: src/awareness/awareness-sync.ts.
	 */
	emit: (
		name: 'change' | 'update',
		args: [ PresenceChange ] | [ PresenceChange, string ]
	) => void;
}

/**
 * The extra members of the presence object core-data builds for a post
 * (`PostEditorAwareness`), on top of the plain one.
 */
export interface PostEditorPresenceObject extends PresenceObject {
	/** Starts the object's own listeners. */
	setUp?: () => void;

	/**
	 * Per-field equality checks. Internal use: the plugin adds a check for
	 * its own `wpRtcBlock` field, because core-data throws on a field it has
	 * no check for, and another tab can send that field at any time.
	 * Used in: src/awareness/registry.ts.
	 */
	equalityFieldChecks?: Record<
		string,
		( a?: unknown, b?: unknown ) => boolean
	>;

	/*
	 * Internal use: the plugin replaces `setLocalStateField` with a wrapper
	 * while slow presence is on, to keep the live caret field from being
	 * sent. Used in: src/awareness/channels/sync-channel.ts.
	 */
}

/*
 * Local edits. core-data hands the plugin every local edit as a batch of
 * operations (`applyEditBatch`). The types below are copies of the ones in
 * Gutenberg's `packages/blocks/src/types.ts` and
 * `packages/core-data/src/entity-sync.ts`. Blocks are named by the editor's
 * own `clientId`. A `null` parent is the top level, and a `null` `before`
 * means "at the end".
 */

/** A block as the block editor holds it. */
export interface EditorBlock {
	clientId: string;
	name: string;
	attributes: Record< string, unknown >;
	innerBlocks: EditorBlock[];
	isValid?: boolean;
	/** Markup pieces of a block whose content is not in an attribute. */
	innerContent?: Array< string | null >;
	originalContent?: string;
}

/** A new block, with its children, and where it goes. */
export interface InsertOperation {
	type: 'insert';
	block: EditorBlock;
	parent: string | null;
	before: string | null;
}

/** A block that went away, with everything inside it. */
export interface RemoveOperation {
	type: 'remove';
	clientId: string;
}

/** A block that changed place. */
export interface MoveOperation {
	type: 'move';
	clientId: string;
	parent: string | null;
	before: string | null;
}

/** A change to something on the block other than an attribute. */
export interface SetBlockPropertyOperation {
	type: 'set-block-property';
	clientId: string;
	property: string;
	previousValue: unknown;
	value: unknown;
}

/**
 * A change to one attribute. The values keep their in-memory types, so a
 * text value can be a rich text object or a plain string of HTML.
 */
export interface SetAttributeOperation {
	type: 'set-attribute';
	clientId: string;
	attribute: string;
	previousValue: unknown;
	value: unknown;
}

/** A change to a field of the record, such as the title. */
export interface SetFieldOperation {
	type: 'set-field';
	field: string;
	previousValue: unknown;
	value: unknown;
}

/** A change to the blocks of a record. */
export type BlockOperation =
	| InsertOperation
	| RemoveOperation
	| MoveOperation
	| SetBlockPropertyOperation
	| SetAttributeOperation;

/** Any change a batch can hold. */
export type EditOperation = BlockOperation | SetFieldOperation;

/**
 * One end of the editor's selection. Any member can be missing: a
 * selected block with no caret has only a `clientId`, and an empty object
 * means no selection.
 */
export interface SelectionEnd {
	clientId?: string;
	attributeKey?: string;
	offset?: number;
}

/**
 * The editor's selection after a batch. core-data types it as `unknown`.
 * This is the shape the block editor really sends.
 */
export interface EditorSelection {
	selectionStart?: SelectionEnd;
	selectionEnd?: SelectionEnd;
	initialPosition?: number | null;
}

/** One local edit, as core-data hands it over before it stores it. */
export interface EditBatch {
	operations: EditOperation[];
	options: {
		/** True for the later keys of a typing run. */
		isCached: boolean;
		/** True when the batch must not become an undo step. */
		undoIgnore: boolean;
	};
	selection?: EditorSelection;
}

/*
 * The sync provider. core-data has one registration point
 * (`registerEntitySyncProvider`, a private API). The plugin hands it a
 * function that receives the context below and returns the manager below.
 * The types are copies of the ones in Gutenberg's
 * `packages/core-data/src/entity-sync.ts`. Five of them are not exported
 * there.
 */

/** A record as core-data holds it. */
export type EntitySyncRecord = Record< string, unknown >;

/** A record's id. Posts have numbers, template parts have text. */
export type EntitySyncRecordId = string | number;

/**
 * The connection state the editor shows. Gutenberg's type has the same
 * shape as the plugin's own.
 */
export type EntitySyncConnectionStatus = ConnectionStatus;

/** What the plugin can ask core-data to do for one loaded record. */
export interface EntitySyncRecordHandlers {
	/**
	 * Writes edits that did not come from the person into the record,
	 * without an undo step. This does not come back as an edit batch.
	 */
	editRecord: (
		edits: EntitySyncRecord,
		options?: { undoIgnore?: boolean }
	) => void;

	/**
	 * The record with its unsaved edits. Do not use it to recover a lost
	 * edit: it returns nothing for some block shapes.
	 */
	getEditedRecord: () => Promise< EntitySyncRecord >;

	/** Fetches the record from the server again. */
	refetchRecord: () => Promise< void >;

	/**
	 * Tells core-data that a local change opened a new undo step in the
	 * plugin's history. core-data notes a placeholder for it and asks the
	 * plugin back when the step is undone or redone.
	 */
	onUndoLevelOpened: () => void;
}

/** What the plugin can ask core-data to do for a loaded collection. */
export interface EntitySyncCollectionHandlers {
	/** Fetches the whole collection from the server again. */
	refetchRecords: () => Promise< void >;
}

/** What core-data knows about a save that is about to go out. */
export interface EntitySyncBeforeSaveContext {
	/** The record as the server last sent it. */
	persistedRecord?: EntitySyncRecord;
	isAutosave: boolean;
}

/** What core-data knows about a save that succeeded. */
export interface EntitySyncAfterSaveContext {
	/** The server's answer. */
	savedRecord: EntitySyncRecord;
	/** The record before the save. Missing for a new record. */
	persistedRecord?: EntitySyncRecord;
	/** The edits that were sent. */
	edits: EntitySyncRecord;
}

/**
 * The plugin's undo history, as core-data calls it. core-data keeps the
 * order of the steps. Each call is for the record whose placeholder is
 * the step to move.
 */
export interface EntitySyncUndoHistory {
	/** Undoes the latest step of a record. False when there was none. */
	undo: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => boolean;

	/** Redoes the step of a record that was undone last. */
	redo: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => boolean;

	/**
	 * Closes the current step of every record. core-data calls it right
	 * before an undo or redo, and when it records an edit of its own. A
	 * local change that waits to be applied must be applied first.
	 */
	stopCapturing: () => void;

	/** Drops the redo steps of every record. */
	clearRedo: () => void;
}

/**
 * Reads and connection controls the editor asks the provider for. The
 * three members about snapshots and stored documents are leftovers of
 * the Yjs design. An engine with no such document answers "none".
 */
export interface EntitySyncServices {
	/** The presence object of a record, for the editor's presence display. */
	getAwareness: (
		objectType: string,
		objectId: string | null
	) => PresenceObject | undefined;
	getEntitySnapshot: (
		objectType: string,
		objectId: string
	) => string | undefined;
	entityContainsSnapshot: (
		objectType: string,
		objectId: string,
		encodedSnapshot: string
	) => boolean;
	createPersistedCRDTDoc: (
		objectType: string,
		objectId: string
	) => Promise< string | null >;
	/** False makes the editor fall back to the post lock. */
	isAvailable?: () => boolean;
	/** Connects again after a connection error. */
	retry?: () => void;
}

/**
 * What core-data knows about how a kind of record syncs. The plugin uses
 * two members.
 */
export interface EntitySyncConfig {
	/**
	 * Builds the presence object for a record, over a stand-in for the
	 * Yjs document (see src/awareness/awareness-sync.ts).
	 */
	createAwareness?: (
		doc: { clientID: number; on: () => void; off: () => void },
		objectId?: string
	) => PresenceObject | undefined;

	/** False for a post type that has collaboration switched off. */
	shouldSync?: ( objectType: string, objectId: string | null ) => boolean;
}

/** What core-data hands the provider when it is created. */
export interface EntitySyncContext {
	getSyncConfig: (
		kind: string,
		name: string
	) => EntitySyncConfig | undefined;

	/**
	 * The handlers for one record, with the one more that reports the
	 * connection state to the editor.
	 */
	recordHandlers: (
		kind: string,
		name: string,
		id: EntitySyncRecordId,
		handlers: EntitySyncRecordHandlers
	) => {
		onStatusChange: ( status: EntitySyncConnectionStatus | null ) => void;
	};

	/** The same for a collection. */
	collectionHandlers: (
		kind: string,
		name: string,
		handlers: EntitySyncCollectionHandlers
	) => {
		onStatusChange: ( status: EntitySyncConnectionStatus | null ) => void;
	};
}

/**
 * The manager the plugin returns. Only `load` is held back by
 * `shouldSync`. core-data calls every other member for every record, so
 * each one must ignore a record the plugin does not sync.
 */
export interface EntitySyncManager {
	readonly services?: EntitySyncServices;

	shouldSync?: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => boolean;

	/**
	 * Called once when a single record arrives from the server, before
	 * core-data stores it. The record holds its parsed `blocks`.
	 */
	load: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId,
		record: EntitySyncRecord,
		handlers: EntitySyncRecordHandlers
	) => void | Promise< void >;

	/** Called when a whole collection is fetched. */
	loadCollection?: (
		kind: string,
		name: string,
		handlers: EntitySyncCollectionHandlers
	) => void | Promise< void >;

	/**
	 * Every local edit, before core-data stores it. A change the plugin
	 * makes in answer must be written in a later task.
	 */
	applyEditBatch: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId | undefined,
		batch: EditBatch
	) => void;

	/** Called right before a save request goes out. */
	beforeSave?: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId,
		edits: EntitySyncRecord,
		context: EntitySyncBeforeSaveContext
	) => EntitySyncRecord | void | Promise< EntitySyncRecord | void >;

	/** Called after a regular save succeeded. */
	afterSave?: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId | undefined,
		context: EntitySyncAfterSaveContext
	) => void;

	/** Called after a record was deleted. */
	unload: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => void;

	/** Called when collaboration is switched off. */
	unloadAll: () => void;

	/**
	 * Whether the plugin holds the record. core-data then leaves the
	 * record's undo history to the plugin.
	 */
	isLoaded?: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => boolean;

	readonly undoHistory?: EntitySyncUndoHistory;
}
