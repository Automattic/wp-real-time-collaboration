/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided by the editor runtime.
import { parse, serialize, serializeRawBlock } from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { getBlock } from '../engines/intent-log/document.js';
import { mintSyncId } from '../engines/intent-log/sync-id.js';
import type { BlockSpec } from '../engines/intent-log/document.js';
import type {
	EngineBlock,
	EngineDocument,
	IntentEnvelope,
} from '../engines/intent-log/engine-types';
import {
	deriveIntents,
	engineDocumentToBlocks,
	type BridgeBlock,
	type RawContentAdapter,
	type RichTextFieldsResolver,
	type SaveMarkupAdapter,
} from '../engines/intent-log-bridge';
import {
	buildConflictRecords,
	type ConflictRecord,
} from '../engines/intent-log-conflicts';
import type { IntentLogSession } from '../engines/intent-log-session';
import type { EntityConflicts } from '../review/entity-source';
import { toEditorBlock } from './block-types';

/*
 * Review decisions: what happens to an edit the engine set aside for a
 * person to decide.
 *
 * The review screens (src/review/) show a record for every set-aside
 * edit and report the reviewer's decision. They never write to the post.
 * This module does: it builds the records from the session, and it turns
 * an accepted decision into ordinary edits under the reviewer's account.
 * The rules are in docs/conflict-review.md.
 */

/** What applying review decisions needs. */
export interface ReviewDecisionsOptions {
	/** The record's session. */
	session: IntentLogSession;
	richTextFields: RichTextFieldsResolver;
	rawContent?: RawContentAdapter;
	saveMarkup?: SaveMarkupAdapter;
	/**
	 * Called with the edits a decision made, so they can become an undo
	 * step.
	 */
	onAuthored: ( envelopes: IntentEnvelope[] ) => void;
}

/** One record's review entry, plus the restore of a single edit. */
export interface ReviewDecisions extends EntityConflicts {
	/**
	 * Makes a set-aside edit again as an ordinary edit at the current
	 * document, then closes it. For markup that was held for approval,
	 * this is the approval: the new edit carries the reviewer's rights.
	 */
	restoreProposal: ( proposalId: string ) => void;
}

/**
 * The lasting id a block carries in its attributes, if any.
 *
 * @param block The block.
 * @return The id.
 */
function syncIdOf( block: BridgeBlock ): string | undefined {
	const { metadata } = block.attributes;

	if ( ! metadata || 'object' !== typeof metadata ) {
		return undefined;
	}

	const syncId = 'syncId' in metadata ? metadata.syncId : undefined;

	if ( 'string' === typeof syncId ) {
		return syncId;
	}

	return undefined;
}

/**
 * The blocks that carry the given ids, at any depth, in the order of the
 * ids.
 *
 * @param blocks The tree.
 * @param ids    The lasting ids.
 * @return The blocks found.
 */
function pickBlocksById( blocks: BridgeBlock[], ids: string[] ): BridgeBlock[] {
	const found = new Map< string, BridgeBlock >();
	const walk = ( list: BridgeBlock[] ) => {
		for ( const block of list ) {
			const syncId = syncIdOf( block );

			if ( syncId && ids.includes( syncId ) && ! found.has( syncId ) ) {
				found.set( syncId, block );
			}

			walk( block.innerBlocks );
		}
	};

	walk( blocks );

	return ids.flatMap( ( id ) => {
		const block = found.get( id );

		if ( block ) {
			return [ block ];
		}

		return [];
	} );
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

			// A raw markup block carries its markup in pieces.
			if ( Array.isArray( block.innerContent ) ) {
				bridge.innerContent = block.innerContent;
			}

			return bridge;
		} );
}

/**
 * A tree with a record's blocks replaced. The replacement takes the place
 * of the first of the ids met in document order, and the other ids are
 * removed. When none of the ids is in the tree (the record proposes new
 * blocks), the replacement goes to the given place.
 *
 * @param blocks        The tree.
 * @param ids           The blocks the record covers.
 * @param replacement   The replacement blocks.
 * @param slot          Where new blocks go: the parent's id (the top
 *                      level when missing) and the index among its
 *                      children.
 * @param slot.parentId The parent's id.
 * @param slot.index    The index.
 * @return The new tree.
 */
function replaceBlocksInTree(
	blocks: BridgeBlock[],
	ids: string[],
	replacement: BridgeBlock[],
	slot: { parentId?: string; index: number }
): BridgeBlock[] {
	let placed = false;
	const walk = ( list: BridgeBlock[] ): BridgeBlock[] => {
		const out: BridgeBlock[] = [];

		for ( const block of list ) {
			const syncId = syncIdOf( block );

			if ( syncId && ids.includes( syncId ) ) {
				if ( ! placed ) {
					placed = true;
					out.push( ...replacement );
				}

				continue;
			}

			out.push( { ...block, innerBlocks: walk( block.innerBlocks ) } );
		}

		return out;
	};
	const rewritten = walk( blocks );

	if ( placed ) {
		return rewritten;
	}

	const insertInto = ( list: BridgeBlock[] ): BridgeBlock[] => {
		const next = list.slice();

		next.splice( Math.min( slot.index, next.length ), 0, ...replacement );

		return next;
	};

	if ( undefined === slot.parentId ) {
		return insertInto( rewritten );
	}

	const intoParent = ( list: BridgeBlock[] ): BridgeBlock[] =>
		list.map( ( block ) => {
			if ( syncIdOf( block ) === slot.parentId ) {
				return {
					...block,
					innerBlocks: insertInto( block.innerBlocks ),
				};
			}

			return { ...block, innerBlocks: intoParent( block.innerBlocks ) };
		} );

	return intoParent( rewritten );
}

/**
 * Reads a text value from an edit's payload.
 *
 * @param value The payload value.
 * @return The text, or undefined.
 */
function textOf( value: unknown ): string | undefined {
	if ( 'string' === typeof value ) {
		return value;
	}

	return undefined;
}

/**
 * Reads a number from an edit's payload.
 *
 * @param value The payload value.
 * @return The number, or 0.
 */
function numberOf( value: unknown ): number {
	if ( 'number' === typeof value ) {
		return value;
	}

	return 0;
}

/**
 * A block spec with new lasting ids for itself and everything inside it.
 *
 * @param spec The block spec.
 * @return The copy.
 */
function withNewIds( spec: BlockSpec ): BlockSpec {
	return {
		...spec,
		syncId: mintSyncId(),
		children: ( spec.children ?? [] ).map( withNewIds ),
	};
}

/**
 * Whether a payload value is a block spec.
 *
 * @param value The payload value.
 * @return Whether it names a block and a block type.
 */
function isBlockSpec( value: unknown ): value is BlockSpec {
	return (
		!! value &&
		'object' === typeof value &&
		'syncId' in value &&
		'blockType' in value &&
		'string' === typeof value.syncId &&
		'string' === typeof value.blockType
	);
}

/**
 * Creates the review entry of one record.
 *
 * @param options The session and the block type helpers.
 * @return The entry for the review registry.
 */
export function createReviewDecisions(
	options: ReviewDecisionsOptions
): ReviewDecisions {
	const { session, richTextFields, rawContent, saveMarkup } = options;
	const blocksOf = ( doc: EngineDocument ): BridgeBlock[] =>
		engineDocumentToBlocks( doc, richTextFields, rawContent );

	/**
	 * The open records: one per set-aside unit, overlapping units folded
	 * into one, each with its three sides rebuilt from the history the
	 * session still holds.
	 */
	const records = (): ConflictRecord[] =>
		buildConflictRecords( session.getOpenProposals(), {
			getDocument: () => session.getDocument(),
			getDocumentAt: ( seq ) => session.getDocumentAt( seq ),
			getLogSince: ( seq ) => session.getLogSince( seq ),
			serializeBlocks: ( doc, ids ) =>
				pickBlocksById( blocksOf( doc ), ids )
					.map( ( block ) => {
						try {
							// A raw markup block keeps its markup in pieces,
							// not in an attribute its save function reads.
							// It is written out by hand: the comment lines
							// around the markup itself.
							if ( rawContent?.is( block.name ) ) {
								const markup = `\n${ rawContent.serialize(
									block
								) }\n`;

								return serializeRawBlock( {
									blockName: block.name,
									attrs: block.attributes,
									innerBlocks: [],
									innerHTML: markup,
									innerContent: [ markup ],
								} );
							}

							return serialize( [
								toEditorBlock( block, true ),
							] );
						} catch {
							return '';
						}
					} )
					.filter( ( markup ) => '' !== markup )
					.join( '\n\n' ),
		} );

	/**
	 * Makes a record's accepted result as ordinary edits that apply
	 * together: the current document with the record's blocks replaced by
	 * the content, compared with the current document. A block that kept
	 * its id and changed its text gives a text edit.
	 *
	 * @param record  The record.
	 * @param content The replacement, as saved block markup. Empty content
	 *                removes the blocks.
	 */
	const authorReplacement = ( record: ConflictRecord, content: string ) => {
		const doc = session.getDocument();

		if ( ! doc ) {
			return;
		}

		const { target } = record.conflict;
		const slot =
			'blocks' === target.type
				? { parentId: target.parentId, index: target.index }
				: { index: 0 };
		/*
		 * The content replaces the whole run the record covers: the blocks
		 * the set-aside edits touch and the blocks between them, which is
		 * what the reviewer saw. Replacing only the touched blocks would
		 * leave a block from in between behind the result, out of order.
		 */
		const replacement =
			'' === content.trim() ? [] : toBridgeBlocks( parse( content ) );
		const tree = replaceBlocksInTree(
			blocksOf( doc ),
			record.spanIds,
			replacement,
			slot
		);
		// Only what the record showed may disappear: the run's blocks and
		// the blocks inside them.
		const removableIds = new Set( record.blockIds );
		const addRemovable = ( blocks: EngineBlock[] ) => {
			for ( const block of blocks ) {
				removableIds.add( block.syncId );
				addRemovable( block.children );
			}
		};
		const collectRun = ( blocks: EngineBlock[] ) => {
			for ( const block of blocks ) {
				if ( record.spanIds.includes( block.syncId ) ) {
					addRemovable( [ block ] );
				} else {
					collectRun( block.children );
				}
			}
		};

		collectRun( doc.root );

		const derived = deriveIntents( doc, tree, {
			removableIds,
			richTextFields,
			rawContent,
			saveMarkup,
		} );

		if ( ! derived || 0 === derived.intents.length ) {
			return;
		}

		options.onAuthored(
			session.authorBatch( derived.intents, {
				txnId: globalThis.crypto.randomUUID(),
				baseSeq: session.getSeq(),
				observe: false,
			} )
		);
	};

	const restoreProposal = ( proposalId: string ) => {
		const proposal = session
			.getOpenProposals()
			.find( ( open ) => open.intent.intentId === proposalId );

		if ( ! proposal ) {
			return;
		}

		/*
		 * The edit is made again at the current document, as an ordinary
		 * edit under the normal rules. Text goes to the end of its field,
		 * or into a new paragraph when the block is gone. Edit types with
		 * no sensible way back are only closed. The card showed their
		 * content, so the reviewer can put it back by hand.
		 */
		const { type, payload } = proposal.intent;
		const doc = session.getDocument();
		const syncId = textOf( payload.syncId ) ?? '';
		const field = textOf( payload.field ) ?? 'content';
		const block = doc ? getBlock( doc, syncId ) : null;
		let restoredText: string | undefined;

		if ( 'insert_text' === type || 'replace_text' === type ) {
			restoredText = textOf( payload.text );
		} else if ( 'replace_attr_content' === type ) {
			restoredText = textOf( payload.newText );
		}

		if ( restoredText ) {
			if ( block ) {
				session.author( 'insert_text', {
					syncId,
					field,
					offset: ( block.fields[ field ]?.text ?? '' ).length,
					text: restoredText,
				} );
			} else {
				session.author( 'insert_block', {
					block: {
						syncId: mintSyncId(),
						blockType: 'core/paragraph',
						text: restoredText,
					},
					parentId: null,
					afterSiblingId: doc?.root.at( -1 )?.syncId ?? null,
				} );
			}
		} else if ( 'set_attr' === type && block ) {
			const key = textOf( payload.key ) ?? '';

			session.author( 'set_attr', {
				syncId,
				key,
				value: payload.value,
				observedVersion: block.attrVersions[ key ] ?? 0,
			} );
		} else if ( 'set_property' === type && doc ) {
			const name = textOf( payload.name ) ?? '';

			session.author( 'set_property', {
				name,
				value: payload.value,
				observedVersion: doc.propVersions?.[ name ] ?? 0,
			} );
		} else if ( 'format_text' === type && block ) {
			/*
			 * A held format. Markup that needs approval travels as a
			 * format over one placeholder character: the character goes in
			 * as plain text, and only the format that carries the markup
			 * is held. Apply it again over the same range, cut to the
			 * text's length.
			 */
			const length = ( block.fields[ field ]?.text ?? '' ).length;
			const start = Math.min( numberOf( payload.start ), length );
			const end = Math.min( numberOf( payload.end ), length );

			if ( start < end ) {
				session.author( 'format_text', {
					syncId,
					field,
					start,
					end,
					format: textOf( payload.format ) ?? '',
					on: payload.on,
				} );
			}
		} else if (
			'insert_block' === type &&
			doc &&
			isBlockSpec( payload.block )
		) {
			/*
			 * Insert the block again under new ids: the first insert never
			 * applied, and new ids avoid any clash with it. A parent that
			 * is gone falls back to the top level, a sibling that is gone
			 * to the end.
			 */
			const wantedParent = textOf( payload.parentId );
			const wantedSibling = textOf( payload.afterSiblingId );
			let parentId: string | null = null;

			if ( wantedParent && getBlock( doc, wantedParent ) ) {
				parentId = wantedParent;
			}

			let afterSiblingId: string | null = null;

			if ( wantedSibling && getBlock( doc, wantedSibling ) ) {
				afterSiblingId = wantedSibling;
			} else if ( null === parentId ) {
				afterSiblingId = doc.root.at( -1 )?.syncId ?? null;
			}

			session.author( 'insert_block', {
				block: withNewIds( payload.block ),
				parentId,
				afterSiblingId,
			} );
		}

		session.resolveProposal( proposalId, 'restored' );
	};

	return {
		list: () => records().map( ( record ) => record.conflict ),

		resolve: ( conflictId, decision ) => {
			const record = records().find(
				( candidate ) => candidate.conflict.id === conflictId
			);

			if ( ! record ) {
				return 'resolved';
			}

			const memberIds = record.members.map(
				( member ) => member.intent.intentId
			);

			if ( 'accept' === decision.action ) {
				if (
					'sequestration' === record.conflict.kind &&
					decision.content === record.conflict.proposed
				) {
					// The held markup is approved as it is: each held edit
					// is made again under the reviewer's account.
					for ( const id of memberIds ) {
						restoreProposal( id );
					}

					return 'resolved';
				}

				if ( undefined !== record.property ) {
					const original =
						record.members.at( -1 )?.intent.payload.value;
					let value: unknown = decision.content;

					// A value that is not text was shown as JSON.
					if ( 'string' !== typeof original ) {
						try {
							value = JSON.parse( decision.content );
						} catch {
							value = decision.content;
						}
					}

					session.author( 'set_property', {
						name: record.property,
						value,
						observedVersion:
							session.getDocument()?.propVersions?.[
								record.property
							] ?? 0,
					} );
				} else {
					authorReplacement( record, decision.content );
				}
			}

			// The record is closed after the replacement, through the same
			// queue. One request carries the edits first and the closing
			// behind them, so a record never closes ahead of the edit that
			// settles it.
			for ( const id of memberIds ) {
				session.resolveProposal( id, 'dismissed' );
			}

			return 'resolved';
		},

		restoreProposal,
	};
}
