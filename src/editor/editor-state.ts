/**
 * WordPress dependencies
 */
import { select, subscribe } from '@wordpress/data';

/**
 * Internal dependencies
 */
import { typingQuietIn } from '../review/typing-hold';
import type { EditorBlock } from './gutenberg-contract';

/*
 * What the provider reads from the editor page besides the edit batches
 * core-data hands it: one block by its clientId, whether the person is
 * typing in a block, and whether text is being composed with an input
 * method.
 *
 * None of this reads the post's content to find an edit. Edits come from
 * the batches only.
 */

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
 * Reads one block from the block editor.
 *
 * @param clientId The block's clientId.
 * @return The block, or undefined when the editor does not hold it.
 */
export function readEditorBlock( clientId: string ): EditorBlock | undefined {
	// The selectors of a store named by text are not typed.
	const block: unknown =
		select( 'core/block-editor' )?.getBlock?.( clientId );

	if ( isEditorBlock( block ) ) {
		return block;
	}

	return undefined;
}

/**
 * Whether the person typed in a block a moment ago.
 *
 * @param clientId The block's clientId.
 * @return Whether the typing in the block has not paused yet.
 */
export function isTypingIn( clientId: string ): boolean {
	return typingQuietIn( clientId, Date.now() ) > 0;
}

let composing = false;
const watched = new WeakSet< Document >();

/**
 * Listens for text composition in a document.
 *
 * @param doc The page's document, or the document of the editor canvas.
 */
function watchDocument( doc: Document ): void {
	if ( watched.has( doc ) ) {
		return;
	}

	watched.add( doc );
	doc.addEventListener(
		'compositionstart',
		() => {
			composing = true;
		},
		true
	);
	doc.addEventListener(
		'compositionend',
		() => {
			composing = false;
		},
		true
	);
}

/**
 * Starts watching for text composition (typing with an input method, as
 * for Japanese or Chinese). The editor does not report composed text
 * until it is committed.
 *
 * The editor canvas is a frame with a document of its own, which can be
 * replaced while the page lives. So every change in the editor's stores
 * is taken as a moment to look for it again.
 */
export function watchComposition(): void {
	const look = () => {
		watchDocument( document );

		const canvas = document.querySelector< HTMLIFrameElement >(
			'iframe[name="editor-canvas"]'
		);

		if ( canvas?.contentDocument ) {
			watchDocument( canvas.contentDocument );
		}
	};

	look();
	subscribe( look );
}

/**
 * Whether text is being composed with an input method right now.
 *
 * @return Whether a composition is under way.
 */
export function isComposing(): boolean {
	return composing;
}
