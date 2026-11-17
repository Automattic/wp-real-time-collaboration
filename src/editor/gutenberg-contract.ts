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
