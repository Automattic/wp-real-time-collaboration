/**
 * Everything this plugin relies on from Gutenberg that is not a public,
 * documented API. When Gutenberg changes, the damage shows here first.
 *
 * So far this file holds the presence object. More of the contract moves
 * here as the plugin stops reaching into Gutenberg from other files.
 */

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

	/*
	 * Internal uses. Each one reaches past what the Awareness class means
	 * other code to touch, so each one can break when core-data changes
	 * how it builds or bundles the object.
	 */

	/**
	 * The plugin writes other tabs' states straight into the map that
	 * `getStates()` returns, and deletes from it. The class has no public
	 * way to set another client's state from plain data.
	 * Used in: src/shared/awareness-sync.ts.
	 */

	/**
	 * A clock per client id. The plugin moves this tab's own clock forward
	 * when the server's list drops this tab, as the class does itself.
	 * Used in: src/shared/awareness-sync.ts.
	 */
	meta: Map< number, { clock: number; lastUpdated: number } >;

	/**
	 * The event method the class inherits. The plugin calls it after it
	 * has changed the map by hand, so the editor's presence display
	 * updates. `change` is for a visible change, `update` for any.
	 * Used in: src/shared/awareness-sync.ts.
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
	 * its own `gseBlock` field, because core-data throws on a field it has
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
