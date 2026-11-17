/**
 * Internal dependencies
 */
import type { EngineDocument } from '../engines/intent-log/engine-types';
import type { CapturedIntent } from './capture';
import type { SetFieldOperation } from './gutenberg-contract';

/*
 * Post fields: the title, the excerpt, the status, the terms, the meta,
 * and the other fields of a record that are not its blocks.
 *
 * The shared document keeps each field as a named value of its own
 * (a property). Two people who change different fields never clash, and
 * two who change the same field are caught for that field only. Meta is
 * kept one key at a time, under the names `meta.<key>`.
 *
 * This module does both directions:
 *
 * - editor to document: a changed field becomes a `set_property` edit
 *   (capturePostFields);
 * - document to editor: the properties the editor has not seen yet become
 *   one edits object for `editRecord` (postFieldEditsToPush).
 *
 * It keeps a little state per record, so a value it just wrote one way is
 * not sent back the other way.
 */

/**
 * The post fields every record syncs. Each record adds the taxonomies of
 * its post type to these, by their REST name (`categories`, `tags`).
 */
export const SYNCED_POST_FIELDS = [
	'title',
	'excerpt',
	'slug',
	'status',
	'comment_status',
	'ping_status',
	'format',
	'sticky',
	'author',
	'featured_media',
	'date',
	'template',
];

/** The start of the property name of a meta key. */
export const META_PROPERTY_PREFIX = 'meta.';

/**
 * Meta keys that never sync. This one holds a saved copy of another
 * engine's document. It is storage, not content.
 */
const DISALLOWED_META_KEYS = new Set( [ '_crdt_document' ] );

/**
 * A value a synced field can hold: text, a number, a yes or no, nothing,
 * or a list of term ids.
 */
type PostFieldValue = string | number | boolean | null | number[];

/**
 * What the engine remembers about one record's fields.
 */
export interface PostFieldsState {
	/** The fields this record syncs. */
	syncedFields: string[];
	/**
	 * The last value of each property that went to the editor or came
	 * from it. A document value equal to it is not pushed again. Meta keys
	 * are in here too, under their `meta.<key>` names.
	 */
	lastSeen: Record< string, unknown >;
	/**
	 * The record's whole meta object as the editor holds it. `editRecord`
	 * replaces `meta` as a whole, so a push of one key must carry the
	 * others too. Its keys also say which meta keys this post has.
	 */
	knownMeta: Record< string, unknown >;
}

/**
 * Whether a value is a list of term ids.
 *
 * @param value Any value.
 * @return True for a list of numbers, an empty one included.
 */
function isTermIdList( value: unknown ): value is number[] {
	return (
		Array.isArray( value ) &&
		value.every( ( item ) => 'number' === typeof item )
	);
}

/**
 * Whether a value is one a synced field can hold.
 *
 * @param value Any value.
 * @return Whether it is text, a number, a yes or no, null, or term ids.
 */
function isPostFieldValue( value: unknown ): value is PostFieldValue {
	return (
		null === value ||
		'string' === typeof value ||
		'number' === typeof value ||
		'boolean' === typeof value ||
		isTermIdList( value )
	);
}

/**
 * Whether a value is a plain object.
 *
 * @param value Any value.
 * @return Whether it is an object that is not a list.
 */
function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && 'object' === typeof value && ! Array.isArray( value );
}

/**
 * Reads a field from a record or from a set of edits.
 *
 * A record from the REST API holds the title and the excerpt as
 * `{ raw, rendered }`. Edits hold them as plain text.
 *
 * @param source A record or a set of edits.
 * @param name   The field.
 * @return The plain value, or undefined when there is none to sync.
 */
function readPostField(
	source: Record< string, unknown >,
	name: string
): PostFieldValue | undefined {
	const value = source[ name ];

	if ( isPostFieldValue( value ) ) {
		return value;
	}

	if ( isRecord( value ) && 'string' === typeof value.raw ) {
		return value.raw;
	}

	return undefined;
}

/**
 * One fixed form of a field value. A list of term ids is a set: the
 * editor adds ids in the order they were clicked and the server lists
 * them by name. Sorting them keeps the same set from looking like a
 * change.
 *
 * @param value A field value.
 * @return The value, with term ids sorted.
 */
function canonicalValue< Value >( value: Value ): Value | number[] {
	if ( isTermIdList( value ) ) {
		return [ ...value ].sort( ( a, b ) => a - b );
	}

	return value;
}

/**
 * Whether two field values are the same. Lists of term ids are compared
 * as sets.
 *
 * @param a One value.
 * @param b The other value.
 * @return Whether they are the same.
 */
function sameFieldValue( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}

	if ( ! isTermIdList( a ) || ! isTermIdList( b ) || a.length !== b.length ) {
		return false;
	}

	const sortedB = canonicalValue( b );

	return canonicalValue( a ).every(
		( item, index ) => item === sortedB[ index ]
	);
}

/**
 * Whether a value is a list or an object with nothing in it.
 *
 * @param value Any value.
 * @return Whether it is empty.
 */
function isEmptyContainer( value: unknown ): boolean {
	if ( Array.isArray( value ) ) {
		return 0 === value.length;
	}

	return isRecord( value ) && 0 === Object.keys( value ).length;
}

/**
 * Whether two JSON values are equal, for meta.
 *
 * An empty list and an empty object count as equal. PHP cannot tell them
 * apart when it writes JSON, so the server can send one for the other.
 *
 * @param a One value.
 * @param b The other value.
 * @return Whether they are equal.
 */
function sameJson( a: unknown, b: unknown ): boolean {
	if ( a === b ) {
		return true;
	}

	if ( Array.isArray( a ) && Array.isArray( b ) ) {
		return (
			a.length === b.length &&
			a.every( ( item, index ) => sameJson( item, b[ index ] ) )
		);
	}

	if ( isRecord( a ) && isRecord( b ) ) {
		const keys = Object.keys( a );

		return (
			keys.length === Object.keys( b ).length &&
			keys.every( ( key ) => key in b && sameJson( a[ key ], b[ key ] ) )
		);
	}

	return isEmptyContainer( a ) && isEmptyContainer( b );
}

/**
 * The `meta` of a record or of a set of edits.
 *
 * @param source A record or a set of edits.
 * @return The meta object, or undefined.
 */
function readMeta(
	source: Record< string, unknown >
): Record< string, unknown > | undefined {
	if ( isRecord( source.meta ) ) {
		return source.meta;
	}

	return undefined;
}

/**
 * Starts the state for a record, from the record the editor loaded.
 *
 * The values the editor already shows are noted as seen. The room's first
 * document holds the same values, and they must not be pushed into the
 * editor as if someone had changed them. A value that differs (someone
 * changed the title before this tab joined) is still pushed.
 *
 * @param record     The record the editor loaded.
 * @param taxonomies The REST names of the post type's taxonomies.
 * @return The state.
 */
export function createPostFieldsState(
	record: Record< string, unknown >,
	taxonomies: string[] = []
): PostFieldsState {
	const syncedFields = [ ...SYNCED_POST_FIELDS, ...taxonomies ];
	const lastSeen: Record< string, unknown > = {};

	for ( const name of syncedFields ) {
		let value = readPostField( record, name );

		if ( undefined === value ) {
			continue;
		}

		// A new post is stored with the title "Auto Draft" while the
		// editor shows an empty title, and the server starts the room with
		// an empty one.
		if (
			'title' === name &&
			'Auto Draft' === value &&
			'auto-draft' === record.status
		) {
			value = '';
		}

		lastSeen[ name ] = canonicalValue( value );
	}

	const meta = readMeta( record ) ?? {};

	for ( const [ key, value ] of Object.entries( meta ) ) {
		if ( ! DISALLOWED_META_KEYS.has( key ) && undefined !== value ) {
			lastSeen[ META_PROPERTY_PREFIX + key ] = value;
		}
	}

	return { syncedFields, lastSeen, knownMeta: { ...meta } };
}

/**
 * Adds the taxonomies of the record's post type to the fields it syncs.
 * They are looked up over REST, so they arrive after the state was made.
 *
 * @param state      The record's state. Changed in place.
 * @param record     The record the editor loaded.
 * @param taxonomies The REST names of the post type's taxonomies.
 */
export function addPostFieldTaxonomies(
	state: PostFieldsState,
	record: Record< string, unknown >,
	taxonomies: string[]
): void {
	for ( const name of taxonomies ) {
		if ( state.syncedFields.includes( name ) ) {
			continue;
		}

		state.syncedFields.push( name );

		const value = readPostField( record, name );

		if ( undefined !== value && ! ( name in state.lastSeen ) ) {
			state.lastSeen[ name ] = canonicalValue( value );
		}
	}
}

/**
 * The fields of a save response that the server changed by itself: the
 * ones that differ from what the browser sent, or from what the record
 * held before when the browser did not send them. The shared document has
 * to learn about them.
 *
 * Meta is compared one key at a time.
 *
 * @param savedRecord     The server's answer to the save.
 * @param persistedRecord The record before the save.
 * @param edits           The edits that were sent.
 * @return The changed fields. `meta` holds only the changed keys.
 */
export function serverChangedFields(
	savedRecord: Record< string, unknown >,
	persistedRecord: Record< string, unknown >,
	edits: Record< string, unknown >
): Record< string, unknown > {
	const changed: Record< string, unknown > = {};
	// The server answers with `{ raw, rendered }` where the browser holds
	// plain text. Compare the plain text.
	const plain = ( value: unknown ): unknown => {
		if ( isRecord( value ) && 'string' === typeof value.raw ) {
			return value.raw;
		}

		return value;
	};

	for ( const [ name, value ] of Object.entries( savedRecord ) ) {
		if ( 'meta' === name ) {
			const baseline = {
				...readMeta( persistedRecord ),
				...readMeta( edits ),
			};
			const changedMeta: Record< string, unknown > = {};

			for ( const [ key, metaValue ] of Object.entries(
				readMeta( savedRecord ) ?? {}
			) ) {
				if (
					! DISALLOWED_META_KEYS.has( key ) &&
					! sameJson( metaValue, baseline[ key ] )
				) {
					changedMeta[ key ] = metaValue;
				}
			}

			if ( Object.keys( changedMeta ).length > 0 ) {
				changed.meta = changedMeta;
			}

			continue;
		}

		const baseline =
			name in edits ? edits[ name ] : persistedRecord[ name ];

		if ( ! sameJson( plain( value ), plain( baseline ) ) ) {
			changed[ name ] = value;
		}
	}

	return changed;
}

/**
 * Forgets which values the editor has seen. After the room starts again
 * from a newer copy, every property of that copy is compared afresh.
 *
 * @param state The record's state. Changed in place.
 */
export function forgetSeenPostFields( state: PostFieldsState ): void {
	state.lastSeen = {};
}

/**
 * The field changes of a batch, as two objects: the new values and the
 * values before.
 *
 * @param operations The `set-field` operations of one batch.
 * @return The new values and the old values, by field.
 */
export function fieldChangesFrom( operations: SetFieldOperation[] ): {
	changes: Record< string, unknown >;
	previous: Record< string, unknown >;
} {
	const changes: Record< string, unknown > = {};
	const previous: Record< string, unknown > = {};

	for ( const operation of operations ) {
		changes[ operation.field ] = operation.value;

		// With several changes to one field, the first old value is the
		// value before the batch.
		if ( ! ( operation.field in previous ) ) {
			previous[ operation.field ] = operation.previousValue;
		}
	}

	return { changes, previous };
}

/**
 * Turns changed fields into `set_property` edits.
 *
 * A field is in `changes` only when it changed, so every field in it is
 * looked at. A value equal to the document's is skipped: it is the echo
 * of a value the engine itself pushed.
 *
 * @param doc      The engine's document.
 * @param changes  The changed fields and their new values. `meta` is the
 *                 whole meta object, or only the changed keys.
 * @param state    The record's state. Changed in place.
 * @param previous The values before the change, when the editor gave
 *                 them. A meta key whose value is the same as before is
 *                 not sent, even when the document does not hold it.
 * @return The edits, in order.
 */
export function capturePostFields(
	doc: EngineDocument,
	changes: Record< string, unknown >,
	state: PostFieldsState,
	previous: Record< string, unknown > = {}
): CapturedIntent[] {
	const intents: CapturedIntent[] = [];
	const setProperty = ( name: string, value: unknown ) => {
		state.lastSeen[ name ] = value;
		intents.push( {
			type: 'set_property',
			payload: {
				name,
				value,
				observedVersion: doc.propVersions?.[ name ] ?? 0,
			},
		} );
	};

	for ( const name of state.syncedFields ) {
		if ( ! ( name in changes ) ) {
			continue;
		}

		let value = readPostField( changes, name );

		if ( undefined === value ) {
			continue;
		}

		value = canonicalValue( value );

		// The placeholder title of a new post never replaces an empty
		// shared title.
		if (
			'title' === name &&
			'Auto Draft' === value &&
			! doc.props?.title
		) {
			value = '';
		}

		// A status the editor cannot show, and an empty slug (the server
		// makes one up), never sync.
		if ( 'status' === name && 'auto-draft' === value ) {
			continue;
		}

		if ( 'slug' === name && ! value ) {
			continue;
		}

		if ( sameFieldValue( doc.props?.[ name ], value ) ) {
			continue;
		}

		setProperty( name, value );
	}

	const meta = readMeta( changes );

	if ( meta ) {
		const previousMeta = readMeta( previous );

		state.knownMeta = { ...state.knownMeta, ...meta };

		for ( const [ key, value ] of Object.entries( meta ) ) {
			if (
				DISALLOWED_META_KEYS.has( key ) ||
				undefined === value ||
				'function' === typeof value
			) {
				continue;
			}

			// The editor sends the whole meta object. A key that did not
			// change is not an edit.
			if (
				previousMeta &&
				key in previousMeta &&
				sameJson( previousMeta[ key ], value )
			) {
				continue;
			}

			const name = META_PROPERTY_PREFIX + key;

			if ( sameJson( doc.props?.[ name ], value ) ) {
				continue;
			}

			setProperty( name, value );
		}
	}

	return intents;
}

/**
 * Collects the property values the editor has not seen yet, as one edits
 * object for `editRecord`.
 *
 * @param doc   The engine's document.
 * @param state The record's state. Changed in place.
 * @return The edits, or null when the editor is up to date.
 */
export function postFieldEditsToPush(
	doc: EngineDocument,
	state: PostFieldsState
): Record< string, unknown > | null {
	const props = doc.props ?? {};
	const edits: Record< string, unknown > = {};

	for ( const name of state.syncedFields ) {
		const value = canonicalValue( props[ name ] );

		// A property can hold anything another tab sent. Only values a
		// field can hold reach the editor.
		if ( undefined === value || ! isPostFieldValue( value ) ) {
			continue;
		}

		if ( sameFieldValue( state.lastSeen[ name ], value ) ) {
			continue;
		}

		if ( 'status' === name && 'auto-draft' === value ) {
			continue;
		}

		state.lastSeen[ name ] = value;
		edits[ name ] = value;
	}

	const metaEdits: Record< string, unknown > = {};

	for ( const [ name, value ] of Object.entries( props ) ) {
		if ( ! name.startsWith( META_PROPERTY_PREFIX ) ) {
			continue;
		}

		const key = name.slice( META_PROPERTY_PREFIX.length );

		if (
			DISALLOWED_META_KEYS.has( key ) ||
			sameJson( state.lastSeen[ name ], value )
		) {
			continue;
		}

		// A key this post does not have is not registered for it. Pushing
		// it would leave the post with unsaved changes for good.
		if ( ! ( key in state.knownMeta ) ) {
			continue;
		}

		state.lastSeen[ name ] = value;
		metaEdits[ key ] = value;
	}

	if ( Object.keys( metaEdits ).length > 0 ) {
		state.knownMeta = { ...state.knownMeta, ...metaEdits };
		edits.meta = state.knownMeta;
	}

	if ( 0 === Object.keys( edits ).length ) {
		return null;
	}

	return edits;
}
