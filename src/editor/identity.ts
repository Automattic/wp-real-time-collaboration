/*
 * The table that links the editor's block ids to the document's block ids.
 *
 * The block editor names a block by its `clientId`, which is new on every
 * page load. The shared document names a block by a lasting id (its
 * `syncId`), which is the same for everyone and is saved with the post.
 * During a session this table is what the engine trusts to tell which
 * editor block is which document block.
 *
 * One editor block links to one document block, and the other way round.
 */

/**
 * The two-way table between `clientId` and `syncId`.
 */
export interface BlockIdentityTable {
	/** The document id of an editor block, if the table knows the block. */
	getSyncId: ( clientId: string ) => string | undefined;

	/** The editor id of a document block, if the editor holds the block. */
	getClientId: ( syncId: string ) => string | undefined;

	/**
	 * Links an editor block to a document block. Any older link of either
	 * id is dropped, so both directions stay one to one.
	 */
	link: ( clientId: string, syncId: string ) => void;

	/** Forgets a document block, for example after it was removed. */
	unlinkSyncId: ( syncId: string ) => void;

	/** Forgets every link. */
	clear: () => void;

	/** How many links the table holds. */
	size: () => number;
}

/**
 * Creates an empty id table.
 *
 * @return The table.
 */
export function createBlockIdentityTable(): BlockIdentityTable {
	const syncIdByClientId = new Map< string, string >();
	const clientIdBySyncId = new Map< string, string >();

	return {
		getSyncId: ( clientId ) => syncIdByClientId.get( clientId ),

		getClientId: ( syncId ) => clientIdBySyncId.get( syncId ),

		link: ( clientId, syncId ) => {
			const previousSyncId = syncIdByClientId.get( clientId );

			if ( undefined !== previousSyncId && previousSyncId !== syncId ) {
				clientIdBySyncId.delete( previousSyncId );
			}

			const previousClientId = clientIdBySyncId.get( syncId );

			if (
				undefined !== previousClientId &&
				previousClientId !== clientId
			) {
				syncIdByClientId.delete( previousClientId );
			}

			syncIdByClientId.set( clientId, syncId );
			clientIdBySyncId.set( syncId, clientId );
		},

		unlinkSyncId: ( syncId ) => {
			const clientId = clientIdBySyncId.get( syncId );

			if ( undefined !== clientId ) {
				syncIdByClientId.delete( clientId );
			}

			clientIdBySyncId.delete( syncId );
		},

		clear: () => {
			syncIdByClientId.clear();
			clientIdBySyncId.clear();
		},

		size: () => syncIdByClientId.size,
	};
}
