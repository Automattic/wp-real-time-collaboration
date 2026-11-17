/**
 * Internal dependencies
 */
import { getBlock, locateBlock } from './intent-log/document.js';
import { mintSyncId } from './intent-log/sync-id.js';
import { textSliceIntents } from './intent-log/text-slices.js';
import { applyIntent } from './intent-log/reducer.js';
import type {
	EngineBlock,
	EngineDocument,
	IntentEnvelope,
} from './intent-log/engine-types';

/*
 * Reverse edits for undo.
 *
 * Undo never rewinds the shared document. It sends new edits that reverse
 * the person's own accepted edits. This file works out the reverse of one
 * accepted edit, from the edit as the server accepted it and the document
 * right before it. Destructive edits carry what they removed, which is
 * what makes them reversible (see SPEC.md, "removedText").
 *
 * The undo steps, their order, and when the reverse edits are sent are in
 * src/editor/undo-history.ts.
 */

/**
 * Invert all slices in reverse application order as one user action.
 * @param entry      Accepted row.
 * @param docBefore  Document before the row.
 * @param currentDoc Current document.
 */
export function deriveInverses(
	entry: IntentEnvelope,
	docBefore: EngineDocument,
	currentDoc: EngineDocument | null
): Array< { type: string; payload: Record< string, unknown > } > {
	const inverses = [];
	let doc = docBefore;
	for ( const part of textSliceIntents( entry ) ) {
		const inverse = deriveInverse( part, doc, currentDoc );
		if ( ! inverse ) {
			return [];
		}
		inverses.unshift( inverse );
		doc = applyIntent( doc, part ).doc;
	}
	return inverses;
}

/**
 * Derives the inverse of an ACCEPTED intent against the document state the
 * row applied to.
 *
 * Exact inverses where the row plus that document determine one; best
 * effort for merge_blocks (the absorbed block's other fields were dropped
 * by the merge) and format_text (spans are unnormalized); null where no
 * sensible inverse exists (the member is skipped).
 *
 * @param entry      The accepted (transformed) intent row.
 * @param docBefore  Document at the row's landing seq (before it applied).
 * @param currentDoc The session's current optimistic document (register
 *                   versions for map/entity writes are read at authoring
 *                   time, the restore-proposal precedent).
 * @return The inverse intent, or null.
 */
export function deriveInverse(
	entry: IntentEnvelope,
	docBefore: EngineDocument,
	currentDoc: EngineDocument | null
): { type: string; payload: Record< string, unknown > } | null {
	const payload = entry.payload as Record< string, any >;
	const blockBefore = ( id: string ): EngineBlock | null =>
		getBlock( docBefore, id );
	const textBefore = ( id: string, field: string ): string =>
		( blockBefore( id )?.fields?.[ field ]?.text as string ) ?? '';
	const attrVersionNow = ( id: string, key: string ): number => {
		const current = currentDoc
			? ( getBlock( currentDoc, id ) as EngineBlock | null )
			: null;
		if ( current ) {
			return ( current.attrVersions?.[ key ] as number ) ?? 0;
		}
		return (
			( ( blockBefore( id )?.attrVersions?.[ key ] as number ) ?? 0 ) + 1
		);
	};
	const propVersionNow = ( name: string ): number =>
		( currentDoc?.propVersions?.[ name ] as number ) ??
		( ( docBefore.propVersions?.[ name ] as number ) ?? 0 ) + 1;
	/**
	 * Deep-copies a document block into an insert_block spec.
	 * @param block
	 */
	const toSpec = ( block: EngineBlock ): Record< string, unknown > => ( {
		syncId: block.syncId,
		blockType: block.blockType,
		attrs: { ...( block.attrs ?? {} ) },
		attrVersions: { ...( block.attrVersions ?? {} ) },
		fields: Object.fromEntries(
			Object.entries( block.fields ?? {} ).map( ( [ name, field ] ) => [
				name,
				{
					text: field.text,
					formats: ( field.formats ?? [] ).map( ( span ) => ( {
						...span,
					} ) ),
				},
			] )
		),
		children: ( block.children ?? [] ).map( toSpec ),
	} );

	switch ( entry.type ) {
		case 'insert_text':
			return {
				type: 'delete_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					start: payload.offset,
					end: payload.offset + payload.text.length,
					removedText: payload.text,
				},
			};

		case 'delete_text':
			return {
				type: 'insert_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					offset: payload.start,
					// The doc-derived text, NOT the carried removedText —
					// transforms do not update the carried copy.
					text: textBefore( payload.syncId, payload.field ).slice(
						payload.start,
						payload.end
					),
				},
			};

		case 'replace_text': {
			const prior = textBefore( payload.syncId, payload.field ).slice(
				payload.start,
				payload.end
			);
			return {
				type: 'replace_text',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					start: payload.start,
					end: payload.start + payload.text.length,
					removedText: payload.text,
					text: prior,
				},
			};
		}

		case 'format_text':
			// Approximate: spans are unnormalized, so toggling off need not
			// restore pre-existing overlapping spans exactly.
			return {
				type: 'format_text',
				payload: { ...payload, on: ! payload.on },
			};

		case 'set_attr': {
			const block = blockBefore( payload.syncId );
			if ( ! block ) {
				return null;
			}
			const hadKey =
				undefined !== ( block.attrs ?? {} )[ payload.key as string ];
			if ( ! hadKey ) {
				return {
					type: 'remove_attr',
					payload: {
						syncId: payload.syncId,
						key: payload.key,
						observedVersion: attrVersionNow(
							payload.syncId,
							payload.key
						),
					},
				};
			}
			return {
				type: 'set_attr',
				payload: {
					syncId: payload.syncId,
					key: payload.key,
					value: block.attrs[ payload.key as string ],
					observedVersion: attrVersionNow(
						payload.syncId,
						payload.key
					),
				},
			};
		}

		case 'remove_attr': {
			const block = blockBefore( payload.syncId );
			if (
				! block ||
				undefined === ( block.attrs ?? {} )[ payload.key as string ]
			) {
				return null;
			}
			return {
				type: 'set_attr',
				payload: {
					syncId: payload.syncId,
					key: payload.key,
					value: block.attrs[ payload.key as string ],
					observedVersion: attrVersionNow(
						payload.syncId,
						payload.key
					),
				},
			};
		}

		case 'set_property': {
			const prior = ( docBefore.props ?? {} )[ payload.name as string ];
			if ( undefined === prior ) {
				return null; // First write: nothing to restore it to.
			}
			return {
				type: 'set_property',
				payload: {
					name: payload.name,
					value: prior,
					observedVersion: propVersionNow( payload.name ),
				},
			};
		}

		case 'insert_block':
			return {
				type: 'remove_block',
				payload: { syncId: payload.block.syncId },
			};

		case 'remove_block': {
			const location = locateBlock( docBefore, payload.syncId );
			if ( ! location ) {
				return null;
			}
			// Original identities re-insert: every id in the removed subtree
			// left the document with the removal, so duplicate-id cannot
			// trip, and peers' anchors to those ids resurrect with it.
			return {
				type: 'insert_block',
				payload: {
					block: toSpec( location.block ),
					parentId: location.parentId,
					afterSiblingId:
						location.index > 0
							? location.siblings[ location.index - 1 ].syncId
							: null,
				},
			};
		}

		case 'move_block': {
			const location = locateBlock( docBefore, payload.syncId );
			if ( ! location ) {
				return null;
			}
			return {
				type: 'move_block',
				payload: {
					syncId: payload.syncId,
					newParentId: location.parentId,
					afterSiblingId:
						location.index > 0
							? location.siblings[ location.index - 1 ].syncId
							: null,
				},
			};
		}

		case 'split_block':
			return {
				type: 'merge_blocks',
				payload: {
					survivorId: payload.syncId,
					absorbedId: payload.newSyncId,
					field: payload.field,
					joinOffset: payload.offset,
				},
			};

		case 'merge_blocks': {
			const survivor = blockBefore( payload.survivorId );
			if ( ! survivor ) {
				return null;
			}
			// Best effort: re-split at the join point. The absorbed block's
			// OTHER fields were dropped by the merge (documented editor
			// semantics) and its id is tombstoned, so the tail comes back
			// under a fresh identity with the joined field only.
			return {
				type: 'split_block',
				payload: {
					syncId: payload.survivorId,
					field: payload.field,
					offset:
						survivor.fields?.[ payload.field as string ]?.text
							?.length ?? 0,
					newSyncId: mintSyncId(),
				},
			};
		}

		case 'transform_block': {
			const block = blockBefore( payload.syncId );
			if ( ! block ) {
				return null;
			}
			return {
				type: 'transform_block',
				payload: {
					syncId: payload.syncId,
					newBlockType: block.blockType,
				},
			};
		}

		case 'replace_attr_content': {
			const prior = textBefore( payload.syncId, payload.field );
			return {
				type: 'replace_attr_content',
				payload: {
					syncId: payload.syncId,
					field: payload.field,
					newText: prior,
					observedVersion: attrVersionNow(
						payload.syncId,
						`field:${ payload.field }`
					),
				},
			};
		}

		default:
			return null;
	}
}
