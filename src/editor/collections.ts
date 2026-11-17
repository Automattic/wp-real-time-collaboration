/**
 * Internal dependencies
 */
import {
	createIntentLogSession,
	randomClientId,
	type IntentLogSession,
} from '../engines/intent-log-session';
import { getProviderCreators } from '../registry/transports';
import type { ProviderCreatorResult } from '../registry/types';
import { createAwarenessDoc } from '../shared/awareness-sync';
import type {
	EntitySyncCollectionHandlers,
	EntitySyncContext,
	PresenceObject,
} from './gutenberg-contract';

/*
 * Collection rooms: one room per kind of record, such as all categories.
 *
 * A collection room does not hold the records. It holds one small value
 * per tab, which that tab raises every time it saves a record of that
 * kind. When another tab's value changes, this tab fetches the list
 * again. That is how a category someone just created shows up in
 * everyone's list.
 */

/**
 * The start of the name of a tab's own value. Each tab writes only its
 * own value, so two tabs that save at the same moment never clash.
 */
const SAVE_PROPERTY_PREFIX = 'savedAt:';

/** One loaded collection room. */
interface CollectionRoom {
	session: IntentLogSession;
	providers: ProviderCreatorResult[];
	unloaded: boolean;
	awareness?: PresenceObject;
	/** The name of this tab's own value. */
	ownProperty: string;
	/** This tab's value. It goes up by one with every save. */
	saves: number;
	/** A save made before the room's first document arrived. */
	pendingSave: boolean;
	/** The other tabs' values as last seen, or null before the first document. */
	lastSeen: string | null;
	/** Whether the first reading of the other tabs' values is on its way. */
	baselinePending: boolean;
}

/** The collection rooms of one provider. */
export interface CollectionRooms {
	/** Joins the room of a kind of record. */
	load: (
		kind: string,
		name: string,
		handlers: EntitySyncCollectionHandlers
	) => Promise< void >;

	/** Tells the other tabs that a record of this kind was saved. */
	announceSave: ( objectType: string ) => void;

	/** The presence object of a room, if it has one. */
	getAwareness: ( objectType: string ) => PresenceObject | undefined;

	/** Connects every room again after a connection error. */
	retry: () => void;

	/** Leaves every room. */
	unloadAll: () => void;
}

/**
 * Creates the collection rooms of a provider.
 *
 * @param context What core-data handed the provider.
 * @param userId  The current user's id.
 * @return The rooms.
 */
export function createCollectionRooms(
	context: EntitySyncContext,
	userId: number
): CollectionRooms {
	const rooms = new Map< string, CollectionRoom >();

	const announceSave = ( objectType: string ) => {
		const room = rooms.get( objectType );

		if ( ! room || room.unloaded ) {
			return;
		}

		if ( ! room.session.isInitialized() ) {
			// Announced when the room's first document arrives.
			room.pendingSave = true;

			return;
		}

		room.saves++;
		room.session.author( 'set_property', {
			name: room.ownProperty,
			value: room.saves,
			observedVersion:
				room.session.getDocument()?.propVersions?.[
					room.ownProperty
				] ?? 0,
		} );
	};

	return {
		async load( kind, name, handlers ) {
			const objectType = `${ kind }/${ name }`;
			const syncConfig = context.getSyncConfig( kind, name );
			const creators = getProviderCreators();

			if (
				rooms.has( objectType ) ||
				! syncConfig ||
				false === syncConfig.shouldSync?.( objectType, null ) ||
				0 === creators.length
			) {
				return;
			}

			const clientId = randomClientId();
			const awareness = syncConfig.createAwareness?.(
				createAwarenessDoc( clientId )
			);
			const session = createIntentLogSession( {
				userId,
				clientId,
				awareness,
			} );
			const room: CollectionRoom = {
				session,
				providers: [],
				unloaded: false,
				awareness,
				ownProperty: `${ SAVE_PROPERTY_PREFIX }u${ userId }c${ clientId }`,
				saves: 0,
				pendingSave: false,
				lastSeen: null,
				baselinePending: false,
			};
			const { onStatusChange } = context.collectionHandlers(
				kind,
				name,
				handlers
			);

			rooms.set( objectType, room );

			// The other tabs' values, as one text that can be compared.
			const othersValues = (): string =>
				JSON.stringify(
					Object.entries( session.getDocument()?.props ?? {} )
						.filter(
							( [ property ] ) =>
								property.startsWith( SAVE_PROPERTY_PREFIX ) &&
								property !== room.ownProperty
						)
						.sort( ( [ a ], [ b ] ) => a.localeCompare( b ) )
				);

			session.onChange( () => {
				if ( room.unloaded || ! session.isInitialized() ) {
					return;
				}

				if ( room.pendingSave ) {
					room.pendingSave = false;
					announceSave( objectType );
				}

				if ( null === room.lastSeen ) {
					/*
					 * The list was fetched right before the room was
					 * joined, so it already holds what the room's values
					 * stand for. The values are noted once the first burst
					 * of rows is in: the room's first document arrives
					 * with its history right behind it.
					 */
					if ( ! room.baselinePending ) {
						room.baselinePending = true;
						void Promise.resolve().then( () => {
							room.lastSeen = othersValues();
						} );
					}

					return;
				}

				const values = othersValues();

				if ( values !== room.lastSeen ) {
					room.lastSeen = values;
					void handlers.refetchRecords().catch( () => {} );
				}
			} );

			room.providers = await Promise.all(
				creators.map( async ( create ) => {
					const provider = await create( {
						objectType,
						objectId: null,
						session,
					} );

					provider.on( 'status', onStatusChange );

					return provider;
				} )
			);

			if ( room.unloaded ) {
				room.providers.forEach( ( provider ) => provider.destroy() );
			}
		},

		announceSave,

		getAwareness: ( objectType ) => rooms.get( objectType )?.awareness,

		retry() {
			for ( const room of rooms.values() ) {
				room.providers.forEach( ( provider ) => provider.retry?.() );
			}
		},

		unloadAll() {
			for ( const room of rooms.values() ) {
				room.unloaded = true;
				room.providers.forEach( ( provider ) => provider.destroy() );
				room.awareness?.destroy?.();
				room.session.destroy();
			}

			rooms.clear();
		},
	};
}
