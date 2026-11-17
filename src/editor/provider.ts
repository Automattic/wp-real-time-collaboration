/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided by the editor runtime.
import { parse } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { registerAwareness } from '../awareness/registry';
import type {
	EngineDocument,
	IntentEnvelope,
} from '../engines/intent-log/engine-types';
import {
	applyDerivedIntents,
	deriveIntents,
	engineDocumentToBlocks,
	type BridgeBlock,
} from '../engines/intent-log-bridge';
import {
	createIntentLogSession,
	randomClientId,
	type IntentLogSession,
} from '../engines/intent-log-session';
import { flushHeldUpdates } from '../providers/http-polling/polling-manager';
import { getProviderCreators } from '../registry/transports';
import type { ProviderCreatorResult } from '../registry/types';
import { createEntityConflictSource } from '../review/entity-source';
import { TYPING_HOLD_MAX_MS } from '../review/typing-hold';
import type { SyncConflictSource } from '../review/types';
import { createAwarenessDoc } from '../shared/awareness-sync';
import {
	createEditorBlockBuilder,
	moveSelection,
	type EditorBlockBuilder,
} from './apply';
import {
	attributeDefaults,
	rawContent,
	richTextFields,
	saveMarkup,
	withAttributeDefaults,
} from './block-types';
import {
	captureBlockOperations,
	type CaptureCounters,
	type CapturedIntent,
} from './capture';
import { createCollectionRooms } from './collections';
import type {
	BlockOperation,
	EditBatch,
	EditorBlock,
	EditorSelection,
	EntitySyncContext,
	EntitySyncManager,
	EntitySyncRecord,
	EntitySyncRecordHandlers,
	EntitySyncRecordId,
	PresenceObject,
	SetFieldOperation,
} from './gutenberg-contract';
import { createBlockIdentityTable, type BlockIdentityTable } from './identity';
import { linkLoadedBlocks, linkSavedIds } from './load';
import {
	addPostFieldTaxonomies,
	capturePostFields,
	createPostFieldsState,
	fieldChangesFrom,
	forgetSeenPostFields,
	postFieldEditsToPush,
	serverChangedFields,
	type PostFieldsState,
} from './post-fields';
import {
	createReviewDecisions,
	type ReviewDecisions,
} from './review-decisions';
import { fetchPostTypeTaxonomies } from './taxonomies';
import { createUndoHistory } from './undo-history';

/*
 * The provider: the intent-log engine as core-data sees it.
 *
 * core-data calls this object when a record loads, for every local edit,
 * around saves, and for undo. The provider keeps one session per record
 * (the engine's document and its link to the server) and moves edits both
 * ways:
 *
 * - editor to engine: every local edit arrives as a batch of operations
 *   (`applyEditBatch`). Capture turns it into engine edits, and the
 *   session applies and sends them.
 * - engine to editor: when the engine's document changes for a reason the
 *   editor does not know (someone else's edit, a correction to a local
 *   edit), the provider hands core-data a new block list (`editRecord`).
 *
 * The one rule that holds it together: THE PROVIDER KNOWS WHAT THE EDITOR
 * SHOWS. It is the document of the last push plus every local batch since
 * (`shown`). A local batch is captured against that document and sent as
 * an edit made at that point of the room's history. The engine combines
 * it with whatever arrived since, as it does for every edit.
 *
 * Nearly always the editor shows the engine's newest document, because a
 * push follows every change at once. It is behind in a few known cases:
 *
 * - A correction to a local edit waits for a later task. core-data
 *   stores a local edit after `applyEditBatch` returns, so a write made
 *   during the call would be overwritten.
 * - Text is being composed with an input method, or a review card waits
 *   for the person to stop typing. A push would take the text away from
 *   under them, so pushes are held (see `shouldHoldPushes`).
 * - A batch arrives before the room's first document. It is kept and
 *   captured when the document is there.
 */

/** How often a held push is tried again, in milliseconds. */
const HELD_PUSH_RETRY_MS = 250;

/** How long a save waits for unsent edits to be sent and answered. */
const SAVE_WAIT_MS = 5000;

/** What the provider can be given besides core-data's context. */
export interface IntentLogProviderOptions {
	/**
	 * Whether text is being composed with an input method right now. A
	 * write to the editor would cancel the composition and lose its text,
	 * so writes wait until it ends.
	 */
	isComposing?: () => boolean;

	/**
	 * Whether the person is still typing in a block. A review card that
	 * follows typing leaves its block editable until the person pauses
	 * (src/review/typing-hold.ts). The typed text is no longer in the
	 * engine's document by then, so a write to the editor would take it
	 * away from under them. Writes wait while the person types in such a
	 * block, for as long as the card may wait.
	 */
	isTypingIn?: ( clientId: string ) => boolean;

	/**
	 * Reads one block from the block editor. Used for two things the
	 * operations do not carry: the saved id of a block the id table does
	 * not know, and the whole markup of a raw markup block that holds
	 * other blocks.
	 */
	readEditorBlock?: ( clientId: string ) => EditorBlock | undefined;

	/** Looks up the taxonomies of a post type. Tests pass a stand-in. */
	fetchTaxonomies?: ( postType: string ) => Promise< string[] >;

	/** Sends the edits the polling transport holds back. Tests pass a stand-in. */
	flushBeforeSave?: () => Promise< void >;

	/** Tells the person that unsent changes were lost. */
	showError?: ( message: string ) => void;
}

/** The document the editor shows, and where it sits in the room's history. */
interface ShownDocument {
	doc: EngineDocument;
	seq: number;
}

/** Everything the provider holds for one loaded record. */
interface RecordState {
	kind: string;
	name: string;
	objectType: string;
	objectId: string;
	session: IntentLogSession;
	handlers: EntitySyncRecordHandlers;
	providers: ProviderCreatorResult[];
	awareness?: PresenceObject;
	unloaded: boolean;
	ids: BlockIdentityTable;
	builder: EditorBlockBuilder;
	fields: PostFieldsState;
	review: ReviewDecisions;
	/** The blocks core-data passed to `load`. */
	loadedBlocks: EditorBlock[];
	/** The saved id of each loaded block that has one, by clientId. */
	savedIds: Map< string, string >;
	/**
	 * Whether the room's first document is there and the editor's blocks
	 * were matched to it. Batches are kept until then.
	 */
	ready: boolean;
	readyTimer: ReturnType< typeof setTimeout > | null;
	heldBatches: EditBatch[];
	/** What the editor shows. Null until the record is ready. */
	shown: ShownDocument | null;
	/**
	 * The editor's blocks, when the room started empty and the editor did
	 * not. The first local block edit sends them along, so the room gets
	 * the post the person is looking at.
	 */
	seedBlocks: EditorBlock[] | null;
	/**
	 * What the editor showed when the server started the room again. The
	 * work in it that the new room lacks is sent again.
	 */
	restartFrom: EngineDocument | null;
	/** The editor's selection after the last batch. */
	selection?: EditorSelection;
	/** True while a local batch is being applied to the session. */
	capturing: boolean;
	pushTimer: ReturnType< typeof setTimeout > | null;
	/** Whether the next push must hand over the blocks even if they look unchanged. */
	forcePush: boolean;
	/** Raw markup blocks whose markup has to be read from the editor. */
	rawContentToRefresh: Set< string >;
	/** When writes started to wait for the person to stop typing. */
	typingHoldSince: number | null;
	counters: CaptureCounters;
}

/**
 * Whether a value is an editor block.
 *
 * @param value Any value.
 * @return Whether it has a clientId, a name, attributes and children.
 */
function isEditorBlock( value: unknown ): value is EditorBlock {
	return (
		!! value &&
		'object' === typeof value &&
		'clientId' in value &&
		'name' in value &&
		'attributes' in value &&
		'innerBlocks' in value &&
		'string' === typeof value.clientId &&
		'string' === typeof value.name &&
		Array.isArray( value.innerBlocks )
	);
}

/**
 * The blocks of a record, as core-data parsed them.
 *
 * @param record The record.
 * @return The blocks, or none.
 */
function blocksOf( record: EntitySyncRecord ): EditorBlock[] {
	if ( ! Array.isArray( record.blocks ) ) {
		return [];
	}

	return record.blocks.filter( isEditorBlock );
}

/**
 * Parsed blocks in the shape the bridge reads. Whitespace between blocks
 * parses as blocks with no name, which are dropped.
 *
 * @param blocks The parsed blocks.
 * @return The blocks.
 */
function toBridgeBlocks( blocks: ReturnType< typeof parse > ): BridgeBlock[] {
	return blocks
		.filter( ( block ) => !! block.name )
		.map( ( block ) => {
			const bridge: BridgeBlock = {
				name: block.name,
				attributes: { ...( block.attributes ?? {} ) },
				innerBlocks: toBridgeBlocks( block.innerBlocks ?? [] ),
			};

			if ( Array.isArray( block.innerContent ) ) {
				bridge.innerContent = block.innerContent;
			}

			return bridge;
		} );
}

/**
 * Tells the person through the editor's notices, when the page has them.
 *
 * @param message The message.
 */
function showEditorError( message: string ): void {
	const { wp } = window as Window & {
		wp?: {
			data?: {
				dispatch?: ( store: string ) => {
					createErrorNotice?: (
						text: string,
						options?: Record< string, unknown >
					) => void;
				};
			};
		};
	};

	wp?.data?.dispatch?.( 'core/notices' )?.createErrorNotice?.( message, {
		id: 'gutenberg-sync-engines-discarded-updates',
		isDismissible: true,
	} );
}

/**
 * Creates the intent-log provider.
 *
 * @param context What core-data hands a provider when it registers.
 * @param options Hooks into the editor, and stand-ins for tests.
 * @return The manager core-data calls, with the engine's review source.
 */
export function createIntentLogProvider(
	context: EntitySyncContext,
	options: IntentLogProviderOptions = {}
): EntitySyncManager & {
	/** Every set-aside edit of a loaded record, for the review screens. */
	conflicts: SyncConflictSource;
	/** Makes one set-aside edit again and closes it. */
	restoreProposal: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId,
		proposalId: string
	) => void;
	/** The counts of unexpected things for one record, for diagnostics. */
	getCounters: (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => CaptureCounters | undefined;
} {
	const records = new Map< string, RecordState >();
	const conflicts = createEntityConflictSource();
	const undo = createUndoHistory();
	const fetchTaxonomies = options.fetchTaxonomies ?? fetchPostTypeTaxonomies;
	const flushBeforeSave = options.flushBeforeSave ?? flushHeldUpdates;
	const showError = options.showError ?? showEditorError;
	const userId =
		Number(
			( window as { _wpCollaborationUserId?: unknown } )
				._wpCollaborationUserId
		) || 0;
	const collections = createCollectionRooms( context, userId );

	const keyOf = (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId
	) => `${ kind }/${ name }:${ recordId }`;

	const stateOf = (
		kind: string,
		name: string,
		recordId: EntitySyncRecordId | undefined
	): RecordState | undefined => {
		if ( undefined === recordId ) {
			return undefined;
		}

		const state = records.get( keyOf( kind, name, recordId ) );

		if ( ! state || state.unloaded ) {
			return undefined;
		}

		return state;
	};

	const documentBlocks = ( doc: EngineDocument ): BridgeBlock[] =>
		engineDocumentToBlocks( doc, richTextFields, rawContent );

	/**
	 * Applies captured edits to the session, as edits made against what
	 * the editor shows.
	 *
	 * @param state   The record.
	 * @param intents The edits.
	 * @param baseSeq The point of the room's history they were made at.
	 * @return The edits as the session sent them.
	 */
	const author = (
		state: RecordState,
		intents: CapturedIntent[],
		baseSeq: number
	): IntentEnvelope[] => {
		if ( 0 === intents.length ) {
			return [];
		}

		// The session reports each edit as a change of its document. Those
		// are the editor's own edits and must not be pushed back at it.
		state.capturing = true;

		try {
			return state.session.authorBatch( intents, {
				baseSeq,
				observe: false,
			} );
		} finally {
			state.capturing = false;
		}
	};

	/**
	 * Notes what the editor shows now.
	 *
	 * @param state The record.
	 * @param doc   The document.
	 * @param seq   Where it sits in the room's history.
	 */
	const setShown = (
		state: RecordState,
		doc: EngineDocument,
		seq: number
	) => {
		state.shown = { doc, seq };
		// The session keeps its copy of the history from here on, so an
		// edit made against this document can still be combined.
		state.session.setObservedSeq( seq );
	};

	/**
	 * Whether a write to the editor has to wait.
	 *
	 * @param state The record.
	 * @return Whether text is being composed, or the person is typing in a
	 *         block whose review card is waiting for them to pause.
	 */
	const shouldHoldPushes = ( state: RecordState ): boolean => {
		if ( options.isComposing?.() ) {
			return true;
		}

		const { isTypingIn } = options;
		let typing = false;

		if ( isTypingIn && state.session.getOpenProposals().length > 0 ) {
			typing = state.review.list().some(
				( conflict ) =>
					true === conflict.followsTyping &&
					'blocks' === conflict.target.type &&
					( conflict.target.ids ?? [] ).some( ( syncId ) => {
						const clientId = state.ids.getClientId( syncId );

						return undefined !== clientId && isTypingIn( clientId );
					} )
			);
		}

		if ( ! typing ) {
			state.typingHoldSince = null;

			return false;
		}

		// The card stops waiting after a while, even for someone who
		// never pauses. So do the writes.
		const now = Date.now();

		state.typingHoldSince = state.typingHoldSince ?? now;

		return now - state.typingHoldSince < TYPING_HOLD_MAX_MS;
	};

	/**
	 * Reads the markup of raw markup blocks from the editor and sends
	 * what changed. The operations of a batch do not hold the whole markup
	 * of such a block when a block inside it changed.
	 *
	 * @param state The record.
	 */
	const refreshRawContent = ( state: RecordState ): void => {
		const { shown } = state;
		const syncIds = [ ...state.rawContentToRefresh ];

		state.rawContentToRefresh.clear();

		if ( ! shown || ! options.readEditorBlock ) {
			return;
		}

		const operations: BlockOperation[] = [];

		for ( const syncId of syncIds ) {
			const clientId = state.ids.getClientId( syncId );
			const block =
				undefined === clientId
					? undefined
					: options.readEditorBlock( clientId );

			if ( undefined !== clientId && block ) {
				operations.push( {
					type: 'set-attribute',
					clientId,
					attribute: 'content',
					previousValue: undefined,
					value: rawContent.serialize( {
						name: block.name,
						attributes: block.attributes,
						innerBlocks: block.innerBlocks,
						innerContent: block.innerContent,
					} ),
				} );
			}
		}

		if ( 0 === operations.length ) {
			return;
		}

		const captured = captureBlockOperations( shown.doc, operations, {
			ids: state.ids,
			richTextFields,
			rawContent,
		} );
		const wasInStep = shown.doc === state.session.getDocument();
		const envelopes = author( state, captured.intents, shown.seq );

		// Part of the edit that changed the block.
		undo.record( state.session, envelopes, false );

		if ( wasInStep ) {
			const doc = state.session.getDocument();

			if ( doc ) {
				setShown( state, doc, state.session.getSeq() );
			}
		} else {
			state.shown = { doc: captured.doc, seq: shown.seq };
		}
	};

	/**
	 * Brings the editor to the engine's document.
	 *
	 * @param state The record.
	 * @param force Hand over the blocks even when they look unchanged.
	 *              The editor's blocks can lack a lasting id that the
	 *              document's blocks carry.
	 */
	const push = ( state: RecordState, force = false ): void => {
		const { session, shown } = state;
		const doc = session.getDocument();

		if ( state.unloaded || ! state.ready || ! shown || ! doc ) {
			return;
		}

		state.forcePush = state.forcePush || force;

		if ( shouldHoldPushes( state ) ) {
			if ( ! state.pushTimer ) {
				state.pushTimer = setTimeout( () => {
					state.pushTimer = null;
					refreshRawContent( state );
					push( state );
				}, HELD_PUSH_RETRY_MS );
			}

			return;
		}

		const edits: EntitySyncRecord = {};

		if ( state.seedBlocks && doc.root.length > 0 ) {
			// The room is not empty after all. Its blocks win.
			state.seedBlocks = null;
		}

		if ( ! state.seedBlocks && ( doc !== shown.doc || state.forcePush ) ) {
			// Build the list the editor shows first, so that the next list
			// shares every block that did not change with it.
			const before =
				doc === shown.doc ? null : state.builder.build( shown.doc );
			const after = state.builder.build( doc );
			const changed =
				state.forcePush ||
				! before ||
				before.length !== after.length ||
				before.some( ( block, index ) => block !== after[ index ] );

			if ( changed ) {
				edits.blocks = after;

				const moved = moveSelection(
					state.selection,
					shown.doc,
					doc,
					state.ids
				);

				if ( moved && moved !== state.selection ) {
					edits.selection = moved;
					state.selection = moved;
				}
			}
		}

		state.forcePush = false;

		const fieldEdits = postFieldEditsToPush( doc, state.fields );

		if ( fieldEdits ) {
			Object.assign( edits, fieldEdits );
		}

		setShown( state, doc, session.getSeq() );

		if ( Object.keys( edits ).length > 0 ) {
			state.handlers.editRecord( edits, { undoIgnore: true } );
		}
	};

	/**
	 * Pushes in a later task. core-data stores a local edit after
	 * `applyEditBatch` returns, so a write made during the call would be
	 * overwritten.
	 *
	 * @param state The record.
	 * @param force See `push`.
	 */
	const pushLater = ( state: RecordState, force: boolean ): void => {
		state.forcePush = state.forcePush || force;

		if ( state.pushTimer ) {
			return;
		}

		state.pushTimer = setTimeout( () => {
			state.pushTimer = null;

			if ( state.unloaded ) {
				return;
			}

			refreshRawContent( state );
			push( state );
		}, 0 );
	};

	/**
	 * Captures one local batch and applies it to the session.
	 *
	 * @param state The record. It must be ready.
	 * @param batch The batch.
	 */
	const processBatch = ( state: RecordState, batch: EditBatch ): void => {
		const { session, shown } = state;

		if ( ! shown ) {
			return;
		}

		const fieldOperations: SetFieldOperation[] = [];
		const blockOperations: BlockOperation[] = [];
		let content: string | undefined;

		for ( const operation of batch.operations ) {
			if ( 'set-field' !== operation.type ) {
				blockOperations.push( operation );
			} else if ( 'content' !== operation.field ) {
				fieldOperations.push( operation );
			} else if ( 'string' === typeof operation.value ) {
				content = operation.value;
			}
		}

		const intents: CapturedIntent[] = [];
		let doc = shown.doc;
		let needsCorrection = false;
		const captureContext = {
			ids: state.ids,
			richTextFields,
			rawContent,
			saveMarkup,
			attributeDefaults,
			lookupSavedSyncId: ( clientId: string ) => {
				const saved = state.savedIds.get( clientId );

				if ( undefined !== saved ) {
					return saved;
				}

				const metadata =
					options.readEditorBlock?.( clientId )?.attributes.metadata;

				if (
					metadata &&
					'object' === typeof metadata &&
					'syncId' in metadata &&
					'string' === typeof metadata.syncId
				) {
					return metadata.syncId;
				}

				return undefined;
			},
		};
		const captureBlocks = (
			operations: BlockOperation[],
			withSelection: boolean
		) => {
			const captured = captureBlockOperations( doc, operations, {
				...captureContext,
				selection: withSelection ? batch.selection : undefined,
				previousSelection: withSelection ? state.selection : undefined,
			} );

			intents.push( ...captured.intents );
			doc = captured.doc;

			state.counters.stalePreviousValue +=
				captured.counters.stalePreviousValue;
			state.counters.caretFallback += captured.counters.caretFallback;
			state.counters.unknownClientId += captured.counters.unknownClientId;
			state.counters.droppedIntents += captured.counters.droppedIntents;

			for ( const syncId of captured.rawContentToRefresh ) {
				state.rawContentToRefresh.add( syncId );
			}

			// The editor is not where the engine thinks it is: a block
			// lacks its lasting id, an old value did not match, or a block
			// was not known. A push puts it right.
			if (
				captured.identityNeedsWrite ||
				captured.counters.stalePreviousValue > 0 ||
				captured.counters.unknownClientId > 0 ||
				captured.rawContentToRefresh.length > 0
			) {
				needsCorrection = true;
			}
		};

		if ( fieldOperations.length > 0 ) {
			const { changes, previous } = fieldChangesFrom( fieldOperations );
			const fieldIntents = capturePostFields(
				doc,
				changes,
				state.fields,
				previous
			);

			intents.push( ...fieldIntents );
			doc = applyDerivedIntents( doc, fieldIntents );
		}

		if ( blockOperations.length > 0 ) {
			if ( state.seedBlocks ) {
				// The room is empty and the editor is not. Send the
				// editor's blocks first, as they were before this edit.
				const seed = state.seedBlocks;

				state.seedBlocks = null;
				captureBlocks(
					seed.map( ( block ) => ( {
						type: 'insert',
						block,
						parent: null,
						before: null,
					} ) ),
					false
				);
			}

			captureBlocks( blockOperations, true );
		}

		if ( undefined !== content ) {
			/*
			 * An edit in the code editor replaces the blocks with raw text.
			 * This is the one place where two whole documents are compared
			 * to find a local edit: the text is parsed, and the result is
			 * compared with the document block by block. A block that kept
			 * its saved id is the same block.
			 */
			const derived = deriveIntents(
				doc,
				toBridgeBlocks( parse( content ) ),
				{
					richTextFields,
					rawContent,
					saveMarkup,
				}
			);

			if ( derived && derived.intents.length > 0 ) {
				intents.push( ...derived.intents );
				doc = applyDerivedIntents( doc, derived.intents );
			}
		}

		const wasInStep = shown.doc === session.getDocument();
		const envelopes = author( state, intents, shown.seq );

		if ( ! batch.options.undoIgnore ) {
			undo.record( session, envelopes, ! batch.options.isCached );
		}

		if ( batch.selection ) {
			state.selection = batch.selection;
		}

		const sessionDoc = session.getDocument();

		if ( wasInStep && sessionDoc ) {
			// The editor showed the engine's document and the edit was
			// applied on top of it: they are still in step.
			setShown( state, sessionDoc, session.getSeq() );
		} else {
			// The editor is behind. It shows its older document plus this
			// edit, and a push is on its way.
			state.shown = { doc, seq: shown.seq };
		}

		if ( needsCorrection || ! wasInStep ) {
			pushLater( state, needsCorrection );
		}
	};

	/**
	 * Makes a record ready once the room's first document and the rows
	 * behind it are there: matches the editor's blocks to the document,
	 * captures the batches that were kept, and brings the editor to the
	 * document.
	 *
	 * @param state The record.
	 */
	const makeReady = ( state: RecordState ): void => {
		const { session } = state;
		const doc = session.getDocument();

		state.readyTimer = null;

		if ( state.unloaded || state.ready || ! doc ) {
			return;
		}

		if ( ! state.shown ) {
			// The first time: tell which editor block is which document
			// block.
			linkLoadedBlocks( state.ids, state.loadedBlocks, doc );
			setShown( state, doc, session.getSeq() );

			if (
				0 === session.getBootstrapSeq() &&
				0 === doc.root.length &&
				state.loadedBlocks.length > 0
			) {
				state.seedBlocks = state.loadedBlocks;
			}
		} else {
			// The server started the room again. The editor still shows
			// its old document, and the session's history starts anew.
			state.shown = { doc: state.shown.doc, seq: session.getSeq() };
		}

		state.ready = true;

		for ( const batch of state.heldBatches.splice( 0 ) ) {
			processBatch( state, batch );
		}

		if ( state.restartFrom && state.shown ) {
			/*
			 * Send the work the editor shows and the new room lacks. The
			 * two documents are compared. Nothing is removed: a block the
			 * new room holds and the editor does not may be someone else's.
			 */
			const current = session.getDocument();
			const derived = current
				? deriveIntents( current, documentBlocks( state.shown.doc ), {
						removableIds: new Set(),
						richTextFields,
						rawContent,
						saveMarkup,
				  } )
				: null;

			state.restartFrom = null;

			if ( derived ) {
				author( state, derived.intents, session.getSeq() );
			}
		}

		// The first push also writes the lasting ids into the editor's
		// blocks, for a post nobody has edited together before.
		push( state, true );
	};

	const scheduleReady = ( state: RecordState ): void => {
		if ( state.ready || state.readyTimer ) {
			return;
		}

		// Not on the first message: the room's history arrives right
		// behind the first document, in the same burst.
		state.readyTimer = setTimeout( () => makeReady( state ), 0 );
	};

	/**
	 * Connects a record's session to the server.
	 *
	 * @param state  The record.
	 * @param record The record the editor loaded.
	 */
	const connect = async (
		state: RecordState,
		record: EntitySyncRecord
	): Promise< void > => {
		if ( 'postType' === state.kind ) {
			addPostFieldTaxonomies(
				state.fields,
				record,
				await fetchTaxonomies( state.name )
			);
		}

		if ( state.unloaded ) {
			return;
		}

		const { onStatusChange } = context.recordHandlers(
			state.kind,
			state.name,
			state.objectId,
			state.handlers
		);

		state.providers = await Promise.all(
			getProviderCreators().map( async ( create ) => {
				const provider = await create( {
					objectType: state.objectType,
					objectId: state.objectId,
					session: state.session,
				} );

				provider.on( 'status', onStatusChange );

				return provider;
			} )
		);

		if ( state.unloaded ) {
			state.providers.forEach( ( provider ) => provider.destroy() );
		}
	};

	const release = ( state: RecordState ): void => {
		state.unloaded = true;

		if ( state.pushTimer ) {
			clearTimeout( state.pushTimer );
		}

		if ( state.readyTimer ) {
			clearTimeout( state.readyTimer );
		}

		undo.detach( state.session );
		state.providers.forEach( ( provider ) => provider.destroy() );
		state.awareness?.destroy?.();
		state.session.destroy();
		conflicts.delete( state.objectType, state.objectId, state.review );
	};

	/**
	 * Waits until the server has answered every edit of a record, or
	 * until the time is up.
	 *
	 * @param state The record.
	 * @return A promise that never rejects.
	 */
	const waitForAnswers = ( state: RecordState ): Promise< void > =>
		new Promise( ( resolve ) => {
			const startedAt = Date.now();
			const check = () => {
				if (
					state.unloaded ||
					0 === state.session.getPendingCount() ||
					Date.now() - startedAt >= SAVE_WAIT_MS
				) {
					resolve();

					return;
				}

				setTimeout( check, 50 );
			};

			check();
		} );

	return {
		conflicts: conflicts.source,

		services: {
			getAwareness: ( objectType, objectId ) => {
				if ( null === objectId ) {
					return collections.getAwareness( objectType );
				}

				return records.get( `${ objectType }:${ objectId }` )
					?.awareness;
			},
			// The server builds the post from the engine's document. There
			// is no document stored with the post in the browser.
			getEntitySnapshot: () => undefined,
			entityContainsSnapshot: () => false,
			createPersistedCRDTDoc: async () => null,
			isAvailable: () => getProviderCreators().length > 0,
			retry: () => {
				for ( const state of records.values() ) {
					state.providers.forEach(
						( provider ) => provider.retry?.()
					);
				}

				collections.retry();
			},
		},

		shouldSync( kind, name, recordId ) {
			const syncConfig = context.getSyncConfig( kind, name );

			return (
				!! syncConfig &&
				false !==
					syncConfig.shouldSync?.(
						`${ kind }/${ name }`,
						String( recordId )
					)
			);
		},

		isLoaded: ( kind, name, recordId ) =>
			undefined !== stateOf( kind, name, recordId ),

		load( kind, name, recordId, record, handlers ) {
			const key = keyOf( kind, name, recordId );
			const objectType = `${ kind }/${ name }`;
			const objectId = String( recordId );
			const syncConfig = context.getSyncConfig( kind, name );

			if (
				records.has( key ) ||
				! syncConfig ||
				false === syncConfig.shouldSync?.( objectType, objectId ) ||
				0 === getProviderCreators().length
			) {
				return;
			}

			/*
			 * The presence object comes from core-data. It only reads a
			 * client id from the document it is given, so a stand-in
			 * serves an engine that has no such document.
			 */
			const clientId = randomClientId();
			const awareness = syncConfig.createAwareness?.(
				createAwarenessDoc( clientId ),
				objectId
			);
			const session = createIntentLogSession( {
				userId,
				clientId,
				awareness,
			} );
			const ids = createBlockIdentityTable();
			const loadedBlocks = blocksOf( record );
			const state: RecordState = {
				kind,
				name,
				objectType,
				objectId,
				session,
				handlers,
				providers: [],
				awareness,
				unloaded: false,
				ids,
				builder: createEditorBlockBuilder( {
					ids,
					richTextFields,
					rawContent,
					withAttributeDefaults,
				} ),
				fields: createPostFieldsState( record ),
				review: createReviewDecisions( {
					session,
					richTextFields,
					rawContent,
					saveMarkup,
					// A decision is one undo step of its own.
					onAuthored: ( envelopes ) =>
						undo.record( session, envelopes, true ),
				} ),
				loadedBlocks,
				savedIds: linkSavedIds( ids, loadedBlocks ),
				ready: false,
				readyTimer: null,
				heldBatches: [],
				shown: null,
				seedBlocks: null,
				restartFrom: null,
				capturing: false,
				pushTimer: null,
				forcePush: false,
				rawContentToRefresh: new Set(),
				typingHoldSince: null,
				counters: {
					stalePreviousValue: 0,
					caretFallback: 0,
					unknownClientId: 0,
					droppedIntents: 0,
				},
			};

			records.set( key, state );
			registerAwareness( objectType, objectId, awareness );
			undo.attach( session, handlers.onUndoLevelOpened );
			conflicts.set( objectType, objectId, state.review );

			session.onChange( () => {
				if (
					state.unloaded ||
					state.capturing ||
					! session.isInitialized()
				) {
					return;
				}

				if ( ! state.ready ) {
					scheduleReady( state );

					return;
				}

				push( state );
			} );

			session.onReset( () => {
				// The room starts again from a newer copy. Every property
				// of that copy is compared with the editor afresh.
				forgetSeenPostFields( state.fields );

				if ( ! session.isInitialized() && state.shown ) {
					// The server threw the room away. Keep batches until
					// the new room's first document is there.
					state.ready = false;
					state.restartFrom = state.shown.doc;
				}
			} );

			session.onStaleBaseRecovery( ( { base, target, seq } ) => {
				if ( state.unloaded ) {
					return;
				}

				/*
				 * The server no longer holds the history some unanswered
				 * edits were made against, so it refused them. The session
				 * still holds it and worked out what the document should
				 * be. Send the difference as new edits. Two engine
				 * documents are compared, not the editor's blocks.
				 */
				const derived = deriveIntents( base, documentBlocks( target ), {
					richTextFields,
					rawContent,
					saveMarkup,
				} );

				if ( derived ) {
					undo.record(
						session,
						author( state, derived.intents, seq ),
						false
					);
				}
			} );

			session.onDiscard( ( updates ) => {
				/*
				 * The transport gave the room up with unsent edits: the
				 * person lost the right to edit, or a limit was reached.
				 * The content is still in the editor, and saving the post
				 * keeps it.
				 */
				// eslint-disable-next-line no-console
				console.error(
					'[wp-real-time-collaboration] Real-time sync stopped with unsent changes:',
					updates.map( ( update ) => update.type )
				);
				showError(
					'Real-time collaboration stopped before your latest changes were sent. They are still in this editor. Save the post to keep them.'
				);
			} );

			/*
			 * Tell the review screens when the open records change. One
			 * notice per burst of rows: a room's history holds set-aside
			 * edits before the rows that close them, and a notice per row
			 * would show long-closed records again on every load.
			 */
			let notifyScheduled = false;
			let recordsChanged = false;
			const scheduleNotify = ( isRecordsChange: boolean ) => {
				recordsChanged = recordsChanged || isRecordsChange;

				if ( notifyScheduled ) {
					return;
				}

				notifyScheduled = true;
				void Promise.resolve().then( () => {
					const mustNotify = recordsChanged;

					notifyScheduled = false;
					recordsChanged = false;

					if ( state.unloaded ) {
						return;
					}

					if ( mustNotify ) {
						conflicts.notify( objectType, objectId );
					} else {
						// The document changed. That matters only when it
						// changed what a record shows.
						conflicts.notifyIfChanged( objectType, objectId );
					}
				} );
			};

			session.onProposalsChange( () => scheduleNotify( true ) );
			session.onChange( () => {
				if ( session.getOpenProposals().length > 0 ) {
					scheduleNotify( false );
				}
			} );

			return connect( state, record );
		},

		loadCollection: ( kind, name, handlers ) =>
			collections.load( kind, name, handlers ),

		applyEditBatch( kind, name, recordId, batch ) {
			const state = stateOf( kind, name, recordId );

			if ( ! state ) {
				return;
			}

			if ( ! state.ready ) {
				state.heldBatches.push( batch );

				return;
			}

			processBatch( state, batch );
		},

		async beforeSave( kind, name, recordId, _edits, { isAutosave } ) {
			const state = stateOf( kind, name, recordId );

			if ( ! state || isAutosave ) {
				return;
			}

			// The room should hold every edit before the saved post
			// changes under it. Send what the transport holds back, then
			// give the server a moment to answer.
			let timer: ReturnType< typeof setTimeout > | undefined;

			try {
				await Promise.race( [
					flushBeforeSave(),
					new Promise< never >( ( _resolve, reject ) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										'Collaboration updates could not be sent. Try saving again.'
									)
								),
							SAVE_WAIT_MS
						);
					} ),
				] );
			} finally {
				clearTimeout( timer );
			}

			await waitForAnswers( state );
		},

		afterSave(
			kind,
			name,
			recordId,
			{ savedRecord, persistedRecord, edits }
		) {
			// Any saved record is announced to its collection room, whether
			// or not the record itself is synced. Nobody edits a category
			// in the editor, yet everyone's list of categories should learn
			// about a new one.
			collections.announceSave( `${ kind }/${ name }` );

			const state = stateOf( kind, name, recordId );

			if ( ! state || ! state.ready || ! state.shown ) {
				return;
			}

			// What the server changed by itself goes into the shared
			// document, and never becomes an undo step.
			const changes = persistedRecord
				? serverChangedFields( savedRecord, persistedRecord, edits )
				: savedRecord;
			const wasInStep = state.shown.doc === state.session.getDocument();
			const intents = capturePostFields(
				state.shown.doc,
				changes,
				state.fields
			);

			author( state, intents, state.shown.seq );

			const doc = state.session.getDocument();

			if ( wasInStep && doc ) {
				setShown( state, doc, state.session.getSeq() );
			} else {
				state.shown = {
					doc: applyDerivedIntents( state.shown.doc, intents ),
					seq: state.shown.seq,
				};
			}
		},

		unload( kind, name, recordId ) {
			const key = keyOf( kind, name, recordId );
			const state = records.get( key );

			if ( state ) {
				release( state );
				records.delete( key );
			}
		},

		unloadAll() {
			for ( const state of records.values() ) {
				release( state );
			}

			records.clear();
			conflicts.clear();
			collections.unloadAll();
			undo.reset();
		},

		undoHistory: {
			undo: ( kind, name, recordId ) => {
				const state = stateOf( kind, name, recordId );

				return !! state && undo.undo( state.session );
			},
			redo: ( kind, name, recordId ) => {
				const state = stateOf( kind, name, recordId );

				return !! state && undo.redo( state.session );
			},
			// Every local batch is applied as it arrives, so nothing waits
			// to be applied here.
			stopCapturing: () => undo.stopCapturing(),
			clearRedo: () => undo.clearRedo(),
		},

		restoreProposal( kind, name, recordId, proposalId ) {
			stateOf( kind, name, recordId )?.review.restoreProposal(
				proposalId
			);
		},

		getCounters: ( kind, name, recordId ) =>
			stateOf( kind, name, recordId )?.counters,
	};
}
