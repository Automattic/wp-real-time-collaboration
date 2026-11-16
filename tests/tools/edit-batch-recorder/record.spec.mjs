/**
 * Drives a real editor through a fixed list of actions and saves what
 * Gutenberg sends to a sync provider for each one.
 *
 * Each scenario writes one JSON file under tests/fixtures/edit-batches/.
 * The "fact" tests at the end answer open questions about the contract and
 * write their answers to tests/fixtures/edit-batches/facts.json.
 *
 * Run it with (see README.md for the site it needs):
 *   npx playwright test --config tests/tools/edit-batch-recorder/playwright.config.mjs
 */

/**
 * External dependencies
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Resolved via the plugin's own devDependency.
import { test, expect } from '@wordpress/e2e-test-utils-playwright';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const OUTPUT_DIR =
	process.env.EDIT_BATCH_OUTPUT_DIR ||
	path.join( here, '../../fixtures/edit-batches' );
const GUTENBERG_COMMIT =
	process.env.GUTENBERG_COMMIT || '061056f94bda96ca20f3e36056737eb36010bda8';

function paragraph( text ) {
	return `<!-- wp:paragraph -->\n<p>${ text }</p>\n<!-- /wp:paragraph -->`;
}

function blocks( ...parts ) {
	return parts.join( '\n\n' );
}

const LIST = [
	'<!-- wp:list -->',
	'<ul class="wp-block-list"><!-- wp:list-item -->',
	'<li>One</li>',
	'<!-- /wp:list-item -->',
	'',
	'<!-- wp:list-item -->',
	'<li>Two</li>',
	'<!-- /wp:list-item --></ul>',
	'<!-- /wp:list -->',
].join( '\n' );

const GROUP = [
	'<!-- wp:group {"layout":{"type":"constrained"}} -->',
	'<div class="wp-block-group"><!-- wp:paragraph -->',
	'<p>Inside</p>',
	'<!-- /wp:paragraph --></div>',
	'<!-- /wp:group -->',
].join( '\n' );

const PATTERN = [
	'<!-- wp:group {"layout":{"type":"constrained"}} -->',
	'<div class="wp-block-group"><!-- wp:heading -->',
	'<h2 class="wp-block-heading">Pattern heading</h2>',
	'<!-- /wp:heading -->',
	'',
	'<!-- wp:paragraph -->',
	'<p>Pattern first</p>',
	'<!-- /wp:paragraph -->',
	'',
	'<!-- wp:paragraph -->',
	'<p>Pattern second</p>',
	'<!-- /wp:paragraph --></div>',
	'<!-- /wp:group -->',
].join( '\n' );

function writeJson( name, data ) {
	fs.mkdirSync( OUTPUT_DIR, { recursive: true } );
	fs.writeFileSync(
		path.join( OUTPUT_DIR, `${ name }.json` ),
		JSON.stringify( data, null, 2 ) + '\n'
	);
}

function recordFact( key, value ) {
	const file = path.join( OUTPUT_DIR, 'facts.json' );
	let facts = {};
	if ( fs.existsSync( file ) ) {
		facts = JSON.parse( fs.readFileSync( file, 'utf8' ) );
	}

	facts[ key ] = value;
	writeJson( 'facts', facts );
}

function collectClientIds( tree ) {
	const ids = [];
	for ( const block of tree || [] ) {
		ids.push( block.clientId );
		ids.push( ...collectClientIds( block.innerBlocks ) );
	}

	return ids;
}

async function openPost( { admin, page, requestUtils }, content ) {
	const post = await requestUtils.createPost( {
		title: 'Edit batch recording',
		content,
		status: 'draft',
	} );
	await admin.editPost( post.id );
	await page.waitForFunction(
		( id ) =>
			window.__editBatchRecorder &&
			window.__editBatchRecorder.events.some(
				( event ) =>
					event.call === 'load' &&
					event.name === 'post' &&
					String( event.recordId ) === String( id )
			),
		post.id
	);
	await page
		.frameLocator( 'iframe[name="editor-canvas"]' )
		.locator( '.is-root-container' )
		.waitFor();

	// Let the editor finish its start-up edits before recording.
	await page.waitForTimeout( 500 );

	return post;
}

async function begin( page ) {
	return page.evaluate( () => {
		const recorder = window.__editBatchRecorder;

		return {
			registered: recorder.registered,
			error: recorder.error,
			flagAtRegistration: recorder.flagAtRegistration,
			mark: recorder.events.length,
			startupEvents: recorder.events.slice(),
			editorTree: recorder.copyTree(
				window.wp.data.select( 'core/block-editor' ).getBlocks()
			),
		};
	} );
}

async function finish( page, { name, description, content, start, notes } ) {
	await page.waitForTimeout( 600 );
	const end = await page.evaluate( ( mark ) => {
		const recorder = window.__editBatchRecorder;

		return {
			events: recorder.events.slice( mark ),
			editorTree: recorder.copyTree(
				window.wp.data.select( 'core/block-editor' ).getBlocks()
			),
			editedContent: window.wp.data
				.select( 'core/editor' )
				.getEditedPostContent(),
		};
	}, start.mark );

	const postLoads = start.startupEvents.filter(
		( event ) => event.call === 'load' && event.name === 'post'
	);
	let loadedIds = [];
	if ( postLoads.length > 0 ) {
		loadedIds = collectClientIds( postLoads[ postLoads.length - 1 ].tree );
	}

	const editorIds = collectClientIds( start.editorTree );

	writeJson( name, {
		scenario: name,
		description,
		gutenbergCommit: GUTENBERG_COMMIT,
		initialContent: content,
		notes: notes || {},
		clientIdsFromLoad: loadedIds,
		clientIdsInEditorAtStart: editorIds,
		clientIdsStableFromLoad:
			JSON.stringify( loadedIds ) === JSON.stringify( editorIds ),
		startupEvents: start.startupEvents,
		editorTreeAtStart: start.editorTree,
		events: end.events,
		editorTreeAtEnd: end.editorTree,
		editedContentAtEnd: end.editedContent,
	} );

	return end;
}

async function blockOrder( page, rootClientId = '' ) {
	return page.evaluate(
		( root ) =>
			window.wp.data.select( 'core/block-editor' ).getBlockOrder( root ),
		rootClientId
	);
}

async function clickBlock( { page }, clientId ) {
	await page
		.frameLocator( 'iframe[name="editor-canvas"]' )
		.locator( `[data-block="${ clientId }"]` )
		.click();
	await page.waitForTimeout( 150 );
}

/**
 * Clicks a block, then puts the caret (or a selection) at exact offsets.
 *
 * @param {Object} context  Test fixtures.
 * @param {string} clientId Block to select.
 * @param {number} start    Start offset in the block's `content`.
 * @param {number} end      End offset. Defaults to the start.
 */
async function placeCaret( context, clientId, start, end = start ) {
	await clickBlock( context, clientId );
	await context.page.evaluate(
		( [ id, from, to ] ) =>
			window.wp.data
				.dispatch( 'core/block-editor' )
				.selectionChange( id, 'content', from, to ),
		[ clientId, start, end ]
	);
	await context.page.waitForTimeout( 200 );
}

async function pause( page, ms = 250 ) {
	await page.waitForTimeout( ms );
}

function scenario( name, description, content, run, before ) {
	test( name, async ( { admin, editor, page, pageUtils, requestUtils } ) => {
		const context = { admin, editor, page, pageUtils, requestUtils };
		let prepared = {};
		if ( before ) {
			prepared = await before( context );
		}

		let initialContent = content;
		if ( typeof content === 'function' ) {
			initialContent = content( prepared );
		}

		const post = await openPost( context, initialContent );
		const start = await begin( page );
		expect( start.error ).toBeNull();
		expect( start.registered ).toBe( true );
		expect( start.flagAtRegistration ).toBe( true );

		const notes = await run( context, { post, prepared } );
		await finish( page, {
			name,
			description,
			content: initialContent,
			start,
			notes,
		} );
	} );
}

test.describe( 'edit batches', () => {
	scenario(
		'typing-at-end',
		'Type " again" at the end of a paragraph, one key at a time.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 11 );
			await context.page.keyboard.type( ' again', { delay: 40 } );
		}
	);

	scenario(
		'typing-inside-repeated-characters',
		'In "aaa", put the caret after the first "a" and type "a", then "b".',
		paragraph( 'aaa' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 1 );
			await context.page.keyboard.type( 'a' );
			await pause( context.page );
			await context.page.keyboard.type( 'b' );
		}
	);

	scenario(
		'emoji',
		'In "Hi 😀 there", put the caret after the emoji, insert "😁", type "x", then press Backspace twice.',
		paragraph( 'Hi 😀 there' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 5 );
			await context.page.keyboard.insertText( '😁' );
			await pause( context.page );
			await context.page.keyboard.type( 'x' );
			await pause( context.page );
			await context.page.keyboard.press( 'Backspace' );
			await pause( context.page );
			await context.page.keyboard.press( 'Backspace' );
		}
	);

	scenario(
		'delete-backward-and-forward',
		'In "Hello world", press Backspace twice at the end, then Delete twice at the start.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 11 );
			await context.page.keyboard.press( 'Backspace' );
			await pause( context.page );
			await context.page.keyboard.press( 'Backspace' );
			await pause( context.page );
			await placeCaret( context, id, 0 );
			await context.page.keyboard.press( 'Delete' );
			await pause( context.page );
			await context.page.keyboard.press( 'Delete' );
		}
	);

	scenario(
		'replace-selection',
		'In "Hello world", select "world" and type "there".',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 6, 11 );
			await context.page.keyboard.type( 'there', { delay: 40 } );
		}
	);

	scenario(
		'bold-and-link',
		'In "Hello world", make "Hello" bold, then turn "world" into a link.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 0, 5 );
			await context.pageUtils.pressKeys( 'primary+b' );
			await pause( context.page );
			await placeCaret( context, id, 6, 11 );
			await context.pageUtils.pressKeys( 'primary+k' );
			await pause( context.page );
			await context.page.keyboard.type( 'https://example.com' );
			await context.page.keyboard.press( 'Enter' );
		}
	);

	scenario(
		'enter-in-middle',
		'In "Hello world", press Enter after "Hello".',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 5 );
			await context.page.keyboard.press( 'Enter' );
		}
	);

	scenario(
		'enter-at-end',
		'In "Hello world", press Enter at the end and type "Next".',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 11 );
			await context.page.keyboard.press( 'Enter' );
			await pause( context.page );
			await context.page.keyboard.type( 'Next', { delay: 40 } );
		}
	);

	scenario(
		'backspace-at-start',
		'With paragraphs "Hello " and "world", press Backspace at the start of the second one.',
		blocks( paragraph( 'Hello ' ), paragraph( 'world' ) ),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await placeCaret( context, second, 0 );
			await context.page.keyboard.press( 'Backspace' );
		}
	);

	scenario(
		'transform-paragraph-to-heading',
		'Change a paragraph into a heading with the block switcher.',
		blocks( paragraph( 'Before' ), paragraph( 'Hello world' ) ),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await clickBlock( context, second );
			await context.editor.transformBlockTo( 'core/heading' );
		}
	);

	scenario(
		'transform-with-typed-prefix',
		'In an empty paragraph, type "## Title". The prefix turns it into a heading.',
		blocks( paragraph( 'Before' ), paragraph( '' ) ),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await clickBlock( context, second );
			await context.page.keyboard.type( '## Title', { delay: 40 } );
		}
	);

	scenario(
		'transform-in-the-middle',
		'With "Before", "Hello world", "After", change the middle paragraph into a heading with the block switcher.',
		blocks(
			paragraph( 'Before' ),
			paragraph( 'Hello world' ),
			paragraph( 'After' )
		),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await clickBlock( context, second );
			await context.editor.transformBlockTo( 'core/heading' );
		}
	);

	scenario(
		'enter-in-middle-with-block-after',
		'With "Hello world" and "After", press Enter after "Hello".',
		blocks( paragraph( 'Hello world' ), paragraph( 'After' ) ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 5 );
			await context.page.keyboard.press( 'Enter' );
		}
	);

	scenario(
		'backspace-at-start-with-block-after',
		'With "Hello ", "world", "After", press Backspace at the start of the second one.',
		blocks(
			paragraph( 'Hello ' ),
			paragraph( 'world' ),
			paragraph( 'After' )
		),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await placeCaret( context, second, 0 );
			await context.page.keyboard.press( 'Backspace' );
		}
	);

	scenario(
		'fast-typing',
		'Type 40 characters at the end of a paragraph with no delay between keys.',
		paragraph( 'Go:' ),
		async ( context ) => {
			const [ id ] = await blockOrder( context.page );
			await placeCaret( context, id, 3 );
			await context.page.keyboard.type(
				' the quick brown fox jumps over the lazy',
				{ delay: 0 }
			);
		}
	);

	scenario(
		'attribute-change',
		'Center a paragraph with the toolbar, set a font size, then clear the alignment again.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const { page, editor } = context;
			const [ id ] = await blockOrder( page );
			await clickBlock( context, id );
			await editor.clickBlockToolbarButton( 'Align text' );
			await page
				.getByRole( 'menuitemradio', { name: 'Align text center' } )
				.click();
			await pause( page );
			await page.evaluate(
				( clientId ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.updateBlockAttributes( clientId, {
							fontSize: 'large',
						} ),
				id
			);
			await pause( page );
			await page.evaluate(
				( clientId ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.updateBlockAttributes( clientId, {
							style: undefined,
							align: undefined,
							textAlign: undefined,
						} ),
				id
			);
		}
	);

	scenario(
		'heading-level-change',
		'Change a heading from level 2 to level 3.',
		'<!-- wp:heading -->\n<h2 class="wp-block-heading">Title</h2>\n<!-- /wp:heading -->',
		async ( context ) => {
			const { page } = context;
			const [ id ] = await blockOrder( page );
			await clickBlock( context, id );
			await page.evaluate(
				( clientId ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.updateBlockAttributes( clientId, { level: 3 } ),
				id
			);
		}
	);

	scenario(
		'duplicate',
		'With paragraphs "One" and "Two", duplicate the first with the keyboard shortcut.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ) ),
		async ( context ) => {
			const [ first ] = await blockOrder( context.page );
			await clickBlock( context, first );
			await context.pageUtils.pressKeys( 'primary+shift+d' );
		}
	);

	scenario(
		'paste-blocks-into-empty-paragraph',
		'With "One", an empty paragraph, and "Two", paste a paragraph, a heading and a list into the empty one.',
		blocks( paragraph( 'One' ), paragraph( '' ), paragraph( 'Two' ) ),
		async ( context ) => {
			const [ , middle ] = await blockOrder( context.page );
			await clickBlock( context, middle );
			context.pageUtils.setClipboardData( {
				plainText: 'Pasted A\n\nPasted B\n\nPasted C',
				html: '<p>Pasted A</p><h2>Pasted B</h2><ul><li>Pasted C</li></ul>',
			} );
			await context.pageUtils.pressKeys( 'primary+v' );
		}
	);

	scenario(
		'paste-blocks-into-text',
		'In "Hello world", paste two paragraphs after "Hello".',
		blocks( paragraph( 'Hello world' ), paragraph( 'After' ) ),
		async ( context ) => {
			const [ first ] = await blockOrder( context.page );
			await placeCaret( context, first, 5 );
			context.pageUtils.setClipboardData( {
				plainText: 'Pasted A\n\nPasted B',
				html: '<p>Pasted A</p><p>Pasted B</p>',
			} );
			await context.pageUtils.pressKeys( 'primary+v' );
		}
	);

	scenario(
		'paste-inline-text',
		'In "Hello world", paste the plain word " big" after "Hello".',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const [ first ] = await blockOrder( context.page );
			await placeCaret( context, first, 5 );
			context.pageUtils.setClipboardData( {
				plainText: ' big',
				html: ' big',
			} );
			await context.pageUtils.pressKeys( 'primary+v' );
		}
	);

	scenario(
		'move-with-shortcut',
		'With "One", "Two", "Three", move the first block down once with the keyboard shortcut, then the last block up once.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ), paragraph( 'Three' ) ),
		async ( context ) => {
			const [ first, , third ] = await blockOrder( context.page );
			await clickBlock( context, first );
			await context.pageUtils.pressKeys( 'secondary+y' );
			await pause( context.page );
			await clickBlock( context, third );
			await context.pageUtils.pressKeys( 'secondary+t' );
		}
	);

	scenario(
		'drag-to-reorder',
		'With "One", "Two", "Three", drag the first block below the third with the mouse.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ), paragraph( 'Three' ) ),
		async ( context ) => {
			const { page, editor } = context;
			const [ first, , third ] = await blockOrder( page );
			await clickBlock( context, first );
			await editor.showBlockToolbar();
			const handle = page
				.getByRole( 'toolbar', { name: 'Block tools' } )
				.getByRole( 'button', { name: 'Drag' } );
			await handle.hover();
			await page.mouse.down();
			const target = await page
				.frameLocator( 'iframe[name="editor-canvas"]' )
				.locator( `[data-block="${ third }"]` )
				.boundingBox();
			const x = target.x + target.width / 2;
			const y = target.y + target.height - 2;
			await page.mouse.move( x, y - 20, { steps: 10 } );
			await page.mouse.move( x, y, { steps: 10 } );
			await page.waitForTimeout( 300 );
			await page.mouse.up();
			await pause( page, 500 );

			return { orderAfter: await blockOrder( page ), first, third };
		}
	);

	scenario(
		'indent-list-item',
		'In a list with "One" and "Two", indent the second item with the toolbar button.',
		LIST,
		async ( context ) => {
			const { page, editor } = context;
			const [ list ] = await blockOrder( page );
			const [ , second ] = await blockOrder( page, list );
			await placeCaret( context, second, 0 );
			await editor.clickBlockToolbarButton( 'Indent' );
		}
	);

	scenario(
		'insert-pattern',
		'With "One" and "Two", insert a pattern (a group holding a heading and two paragraphs) between them.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ) ),
		async ( context ) => {
			await context.page.evaluate( ( html ) => {
				const parsed = window.wp.blocks.parse( html );
				window.wp.data
					.dispatch( 'core/block-editor' )
					.insertBlocks( parsed, 1 );
			}, PATTERN );
		}
	);

	scenario(
		'slash-insert',
		'In an empty paragraph, type "/heading", press Enter, and type "Title".',
		blocks( paragraph( 'Before' ), paragraph( '' ) ),
		async ( context ) => {
			const { page } = context;
			const [ , second ] = await blockOrder( page );
			await clickBlock( context, second );
			await page.keyboard.type( '/heading', { delay: 40 } );
			await page
				.getByRole( 'option', { name: 'Heading', exact: true } )
				.waitFor();
			await page.keyboard.press( 'Enter' );
			await pause( page );
			await page.keyboard.type( 'Title', { delay: 40 } );
		}
	);

	scenario(
		'remove-block',
		'With "One" and "Two", remove the second block with the keyboard shortcut.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ) ),
		async ( context ) => {
			const [ , second ] = await blockOrder( context.page );
			await clickBlock( context, second );
			await context.pageUtils.pressKeys( 'access+z' );
		}
	);

	scenario(
		'select-all-and-delete',
		'With "One", "Two", "Three", select every block and press Backspace.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ), paragraph( 'Three' ) ),
		async ( context ) => {
			const [ first ] = await blockOrder( context.page );
			await clickBlock( context, first );
			await context.pageUtils.pressKeys( 'primary+a' );
			await context.pageUtils.pressKeys( 'primary+a' );
			await pause( context.page );
			await context.page.keyboard.press( 'Backspace' );
		}
	);

	scenario(
		'group-blocks',
		'With "One" and "Two", select both and group them from the block menu.',
		blocks( paragraph( 'One' ), paragraph( 'Two' ) ),
		async ( context ) => {
			const { page, editor } = context;
			const order = await blockOrder( page );
			await page.evaluate(
				( [ from, to ] ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.multiSelect( from, to ),
				order
			);
			await pause( page );
			await editor.clickBlockOptionsMenuItem( 'Group' );
		}
	);

	scenario(
		'move-into-group',
		'With "One" and a group, move "One" into the group. This is a move between two block lists.',
		blocks( paragraph( 'One' ), GROUP ),
		async ( context ) => {
			const { page } = context;
			const [ first, group ] = await blockOrder( page );
			await page.evaluate(
				( [ id, target ] ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.moveBlocksToPosition( [ id ], '', target, 0 ),
				[ first, group ]
			);
		}
	);

	scenario(
		'more-than-64-changes',
		'Three steps. 70 inserts at the top inside one data batch. Then 70 changes to one attribute inside one data batch. Then 5 inserts at the top in a plain loop.',
		blocks( paragraph( 'Start' ), paragraph( 'End' ) ),
		async ( context ) => {
			const { page } = context;

			// The default registry's `batch` is only reachable from inside
			// a store, so register a tiny one that runs a callback in it.
			await page.evaluate( () => {
				const { createReduxStore, register } = window.wp.data;
				register(
					createReduxStore( 'edit-batch-recorder/batch', {
						reducer: ( state = {} ) => state,
						actions: {
							run:
								( callback ) =>
								( { registry } ) =>
									registry.batch( callback ),
						},
					} )
				);
			} );
			await page.evaluate( () => {
				const { dispatch } = window.wp.data;
				dispatch( 'edit-batch-recorder/batch' ).run( () => {
					for ( let i = 0; i < 70; i++ ) {
						dispatch( 'core/block-editor' ).insertBlock(
							window.wp.blocks.createBlock( 'core/paragraph', {
								content: 'Batched ' + i,
							} ),
							1
						);
					}
				} );
			} );
			await pause( page, 500 );
			await page.evaluate( () => {
				const { dispatch, select } = window.wp.data;
				const [ first ] = select( 'core/block-editor' ).getBlockOrder();
				dispatch( 'edit-batch-recorder/batch' ).run( () => {
					for ( let i = 0; i < 70; i++ ) {
						dispatch( 'core/block-editor' ).updateBlockAttributes(
							first,
							{ content: 'Start ' + i }
						);
					}
				} );
			} );
			await pause( page, 500 );
			await page.evaluate( () => {
				const { dispatch } = window.wp.data;
				for ( let i = 0; i < 5; i++ ) {
					dispatch( 'core/block-editor' ).insertBlock(
						window.wp.blocks.createBlock( 'core/paragraph', {
							content: 'Looped ' + i,
						} ),
						0
					);
				}
			} );
		}
	);

	scenario(
		'undo-and-redo',
		'Type " abc" at the end of "Hello", wait, undo, then redo.',
		paragraph( 'Hello' ),
		async ( context ) => {
			const { page, pageUtils } = context;
			const [ id ] = await blockOrder( page );
			await placeCaret( context, id, 5 );
			await page.keyboard.type( ' abc', { delay: 40 } );
			await pause( page, 1200 );
			await pageUtils.pressKeys( 'primary+z' );
			await pause( page, 500 );
			await pageUtils.pressKeys( 'primary+shift+z' );
		}
	);

	scenario(
		'code-editor-edit',
		'Switch to the code editor, type "X" at the end of the content, switch back, then type "!" in the first paragraph.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const { page, pageUtils } = context;
			await page.evaluate( () =>
				window.wp.data
					.dispatch( 'core/editor' )
					.switchEditorMode( 'text' )
			);
			const textarea = page.getByRole( 'textbox', {
				name: 'Type text or HTML',
			} );
			await textarea.click();
			await pageUtils.pressKeys( 'primary+a' );
			await page.keyboard.press( 'ArrowRight' );
			await page.keyboard.type( 'X' );
			await pause( page, 500 );
			await page.evaluate( () =>
				window.wp.data
					.dispatch( 'core/editor' )
					.switchEditorMode( 'visual' )
			);
			await pause( page, 800 );

			// Back in the visual editor the blocks were parsed again. Type
			// in the first one to see which ids the next batch names.
			const [ first ] = await blockOrder( page );
			await placeCaret( context, first, 11 );
			await page.keyboard.type( '!' );

			return { firstBlockAfterSwitch: first };
		}
	);

	scenario(
		'title-change',
		'Type " More" at the end of the title.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const { page } = context;
			const title = page
				.frameLocator( 'iframe[name="editor-canvas"]' )
				.getByRole( 'textbox', { name: 'Add title' } );
			await title.click();
			await context.pageUtils.pressKeys( 'primary+a' );
			await page.keyboard.press( 'ArrowRight' );
			await page.keyboard.type( ' More', { delay: 40 } );
		}
	);

	scenario(
		'meta-change',
		'Change a registered meta field twice.',
		paragraph( 'Hello world' ),
		async ( context ) => {
			const { page } = context;
			await page.evaluate( () =>
				window.wp.data.dispatch( 'core/editor' ).editPost( {
					meta: { edit_batch_recorder_note: 'first' },
				} )
			);
			await pause( page );
			await page.evaluate( () =>
				window.wp.data.dispatch( 'core/editor' ).editPost( {
					meta: { edit_batch_recorder_note: 'second' },
				} )
			);
		}
	);

	scenario(
		'caret-move-without-edit',
		'Click in "Hello world", press ArrowLeft three times, click the second paragraph, press ArrowRight.',
		blocks( paragraph( 'Hello world' ), paragraph( 'Second' ) ),
		async ( context ) => {
			const { page } = context;
			const [ first, second ] = await blockOrder( page );
			await placeCaret( context, first, 11 );
			for ( let i = 0; i < 3; i++ ) {
				await page.keyboard.press( 'ArrowLeft' );
				await pause( page, 150 );
			}

			await clickBlock( context, second );
			await page.keyboard.press( 'ArrowRight' );
		}
	);

	scenario(
		'input-method-composition',
		'In an empty paragraph, compose "にほん" with an input method, commit it as "日本", then type "x".',
		paragraph( '' ),
		async ( context ) => {
			const { page } = context;
			const [ id ] = await blockOrder( page );
			await clickBlock( context, id );
			const client = await page.context().newCDPSession( page );
			const steps = [ 'ｎ', 'に', 'にｈ', 'にほ', 'にほｎ', 'にほん' ];
			for ( const text of steps ) {
				await client.send( 'Input.imeSetComposition', {
					text,
					selectionStart: text.length,
					selectionEnd: text.length,
				} );
				await pause( page, 120 );
			}

			await client.send( 'Input.insertText', { text: '日本' } );
			await pause( page );
			await page.keyboard.type( 'x' );
		}
	);

	scenario(
		'reusable-block-edit',
		'A post holds a synced pattern. Open the pattern with "Edit original" and type " edit" at the end of its paragraph.',
		( prepared ) =>
			blocks(
				`<!-- wp:block {"ref":${ prepared.blockId }} /-->`,
				paragraph( 'After' )
			),
		async ( context, { prepared } ) => {
			const { page, editor } = context;
			const canvas = page.frameLocator( 'iframe[name="editor-canvas"]' );
			await canvas
				.locator( '[data-type="core/block"] [data-type="core/paragraph"]' )
				.waitFor();
			const [ first ] = await blockOrder( page );
			await page.evaluate(
				( id ) =>
					window.wp.data
						.dispatch( 'core/block-editor' )
						.selectBlock( id ),
				first
			);
			await editor.showBlockToolbar();
			await page
				.getByRole( 'toolbar', { name: 'Block tools' } )
				.getByRole( 'button', { name: 'Edit original' } )
				.click();
			await page.waitForFunction(
				( id ) =>
					window.wp.data.select( 'core/editor' ).getCurrentPostId() ===
					id,
				prepared.blockId
			);
			await pause( page, 800 );
			const [ inner ] = await blockOrder( page );
			await placeCaret( context, inner, 11 );
			await page.keyboard.type( ' edit', { delay: 40 } );

			return { blockId: prepared.blockId };
		},
		async ( { requestUtils } ) => {
			const block = await requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/blocks',
				data: {
					title: 'Recorder synced pattern',
					content: paragraph( 'Synced text' ),
					status: 'publish',
				},
			} );

			return { blockId: block.id };
		}
	);

	scenario(
		'template-part-edit',
		'A post holds a template part block. Type " edit" in the paragraph inside the part.',
		'<!-- wp:template-part {"slug":"recorder-part","theme":"emptytheme"} /-->\n\n' +
			paragraph( 'After' ),
		async ( context ) => {
			const { page } = context;
			const canvas = page.frameLocator( 'iframe[name="editor-canvas"]' );
			const inner = canvas.locator(
				'[data-type="core/template-part"] [data-type="core/paragraph"]'
			);
			await inner.waitFor();
			const innerId = await inner.getAttribute( 'data-block' );

			// A template part covers its inner blocks until it is selected,
			// so select the part first.
			await canvas.locator( '[data-type="core/template-part"]' ).click( {
				position: { x: 5, y: 5 },
				force: true,
			} );
			await pause( page );
			await placeCaret( context, innerId, 9 );
			await page.keyboard.type( ' edit', { delay: 40 } );

			return { innerId };
		},
		async ( { requestUtils } ) => {
			try {
				await requestUtils.rest( {
					method: 'DELETE',
					path: '/wp/v2/template-parts/emptytheme//recorder-part',
					params: { force: true },
				} );
			} catch ( error ) {
				// Nothing to delete on a fresh site.
			}

			await requestUtils.rest( {
				method: 'POST',
				path: '/wp/v2/template-parts',
				data: {
					slug: 'recorder-part',
					theme: 'emptytheme',
					title: 'Recorder part',
					content: paragraph( 'Part text' ),
					area: 'uncategorized',
				},
			} );

			return {};
		}
	);
} );

test.describe( 'open facts', () => {
	test( 'a change pushed with editRecord does not come back as a local batch', async ( {
		admin,
		page,
		requestUtils,
	} ) => {
		const post = await openPost(
			{ admin, page, requestUtils },
			blocks( paragraph( 'Hello world' ), paragraph( 'Second' ) )
		);
		const result = await page.evaluate( async ( id ) => {
			const recorder = window.__editBatchRecorder;
			const { select } = window.wp.data;
			const handlers = recorder.handlers[ 'postType/post/' + id ];
			const before = recorder.events.length;
			const current = select( 'core/block-editor' ).getBlocks();
			const pushed = current.map( ( block, index ) => {
				if ( index !== 0 ) {
					return block;
				}

				return {
					...block,
					attributes: {
						...block.attributes,
						content: window.wp.richText.RichTextData.fromHTMLString(
							'Hello remote world'
						),
					},
				};
			} );
			handlers.editRecord( { blocks: pushed } );
			await new Promise( ( resolve ) => setTimeout( resolve, 1000 ) );
			const after = select( 'core/block-editor' ).getBlocks();

			return {
				eventsCaused: recorder.events.slice( before ),
				editorShowsPush:
					String( after[ 0 ].attributes.content ) ===
					'Hello remote world',
				clientIdsKept:
					after[ 0 ].clientId === current[ 0 ].clientId &&
					after[ 1 ].clientId === current[ 1 ].clientId,
			};
		}, post.id );

		recordFact( 'pushDoesNotComeBackAsLocalBatch', {
			question:
				'Does a change pushed with editRecord come back through applyEditBatch?',
			batchesCausedByPush: result.eventsCaused.filter(
				( event ) => event.call === 'applyEditBatch'
			).length,
			eventsCausedByPush: result.eventsCaused,
			editorShowsPush: result.editorShowsPush,
			clientIdsKept: result.clientIdsKept,
		} );
		expect( result.editorShowsPush ).toBe( true );
	} );

	test( 'when the block editor holds a pushed change', async ( {
		admin,
		page,
		requestUtils,
	} ) => {
		const post = await openPost(
			{ admin, page, requestUtils },
			blocks( paragraph( 'Hello world' ), paragraph( 'Second' ) )
		);
		const [ first ] = await blockOrder( page );
		await clickBlock( { page }, first );
		const result = await page.evaluate( async ( id ) => {
			const recorder = window.__editBatchRecorder;
			const { select } = window.wp.data;
			const handlers = recorder.handlers[ 'postType/post/' + id ];
			const frame = document.querySelector(
				'iframe[name="editor-canvas"]'
			);
			const runs = [];

			function nextTask() {
				return new Promise( ( resolve ) => {
					const channel = new MessageChannel();
					channel.port1.onmessage = () => resolve();
					channel.port2.postMessage( null );
				} );
			}

			function read( clientId ) {
				const store = String(
					select( 'core/block-editor' ).getBlockAttributes(
						clientId
					).content
				);
				const element = frame.contentDocument.querySelector(
					`[data-block="${ clientId }"]`
				);
				let dom = null;
				if ( element ) {
					dom = element.textContent;
				}

				return { store, dom };
			}

			for ( let run = 0; run < 20; run++ ) {
				const current = select( 'core/block-editor' ).getBlocks();
				const clientId = current[ 0 ].clientId;
				const text = 'Pushed ' + run;
				const pushed = current.map( ( block, index ) => {
					if ( index !== 0 ) {
						return block;
					}

					return {
						...block,
						attributes: {
							...block.attributes,
							content:
								window.wp.richText.RichTextData.fromHTMLString(
									text
								),
						},
					};
				} );
				handlers.editRecord( { blocks: pushed } );
				const sameTask = read( clientId );
				await Promise.resolve();
				const microtask = read( clientId );
				await nextTask();
				const firstNextTask = read( clientId );
				await nextTask();
				const secondNextTask = read( clientId );
				await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
				const later = read( clientId );
				runs.push( {
					text,
					sameTask,
					microtask,
					firstNextTask,
					secondNextTask,
					later,
				} );
			}

			return runs;
		}, post.id );

		function count( stage, where ) {
			return result.filter( ( run ) => run[ stage ][ where ] === run.text )
				.length;
		}

		const stages = [
			'sameTask',
			'microtask',
			'firstNextTask',
			'secondNextTask',
			'later',
		];
		const summary = {};
		for ( const stage of stages ) {
			summary[ stage ] = {
				blockEditorStoreHasPush: `${ count( stage, 'store' ) } of ${
					result.length
				}`,
				domHasPush: `${ count( stage, 'dom' ) } of ${ result.length }`,
			};
		}

		recordFact( 'whenTheBlockEditorHoldsAPush', {
			question:
				'After editRecord, when do the block editor store and the page show the pushed blocks?',
			summary,
		} );
	} );

	test( 'typing while changes are pushed', async ( {
		admin,
		page,
		requestUtils,
	} ) => {
		test.setTimeout( 180_000 );
		const post = await openPost(
			{ admin, page, requestUtils },
			blocks( paragraph( 'Typed:' ), paragraph( 'Remote:' ) )
		);
		const [ typed ] = await blockOrder( page );
		const outcomes = {};

		// Two rounds. First the pushes change another paragraph, then they
		// change the paragraph that is being typed in.
		for ( const target of [ 'other-paragraph', 'same-paragraph' ] ) {
			await placeCaret( { page }, typed, 6 );
			await page.evaluate(
				( [ id, mode ] ) => {
					const recorder = window.__editBatchRecorder;
					const { select } = window.wp.data;
					const { RichTextData } = window.wp.richText;
					const handlers = recorder.handlers[ 'postType/post/' + id ];
					const stress = {
						mode,
						pushes: 0,
						localBatches: 0,
						mismatches: [],
						engine: {},
						mark: recorder.events.length,
					};
					recorder.stress = stress;

					// The "engine" copy of both paragraphs' text.
					for ( const block of select(
						'core/block-editor'
					).getBlocks() ) {
						stress.engine[ block.clientId ] = String(
							block.attributes.content
						);
					}

					stress.readNewBatches = () => {
						const fresh = recorder.events.slice( stress.mark );
						stress.mark = recorder.events.length;
						for ( const event of fresh ) {
							if ( event.call !== 'applyEditBatch' ) {
								continue;
							}

							for ( const operation of event.batch.operations ) {
								if (
									operation.type !== 'set-attribute' ||
									operation.attribute !== 'content'
								) {
									continue;
								}

								stress.localBatches++;
								const known =
									stress.engine[ operation.clientId ];
								const previous = operation.previousValue.html;
								if ( previous !== known ) {
									stress.mismatches.push( {
										engineHad: known,
										editorHad: previous,
										editorNow: operation.value.html,
									} );
								}

								stress.engine[ operation.clientId ] =
									operation.value.html;
							}
						}
					};

					stress.timer = setInterval( () => {
						// A push is built from the engine's own copy, which
						// has seen every local batch so far.
						stress.readNewBatches();
						const current = select(
							'core/block-editor'
						).getBlocks();
						let targetIndex = 1;
						if ( mode === 'same-paragraph' ) {
							targetIndex = 0;
						}

						const targetId = current[ targetIndex ].clientId;
						stress.engine[ targetId ] =
							stress.engine[ targetId ] + 'r';
						const pushed = current.map( ( block ) => ( {
							...block,
							attributes: {
								...block.attributes,
								content: RichTextData.fromHTMLString(
									stress.engine[ block.clientId ]
								),
							},
						} ) );
						handlers.editRecord( { blocks: pushed } );
						stress.pushes++;
					}, 7 );
				},
				[ post.id, target ]
			);

			await page.keyboard.type(
				'the quick brown fox jumps over the lazy dog '.repeat( 5 ),
				{ delay: 0 }
			);
			await page.waitForTimeout( 300 );
			outcomes[ target ] = await page.evaluate( () => {
				const stress = window.__editBatchRecorder.stress;
				clearInterval( stress.timer );
				stress.readNewBatches();

				return {
					pushes: stress.pushes,
					localTextBatches: stress.localBatches,
					batchesWherePreviousValueWasBehind:
						stress.mismatches.length,
					firstMismatches: stress.mismatches.slice( 0, 5 ),
				};
			} );
			await page.waitForTimeout( 300 );
		}

		recordFact( 'typingWhileChangesArePushed', {
			question:
				'When a push arrives between keystrokes, does the next keystroke report a previousValue that is behind the engine?',
			method: 'A timer pushes a change every 7 ms while 220 keys are typed with no delay.',
			outcomes,
		} );
	} );

	test( 'a push while text is being composed', async ( {
		admin,
		page,
		requestUtils,
	} ) => {
		const post = await openPost(
			{ admin, page, requestUtils },
			blocks( paragraph( 'Composing:' ), paragraph( 'Other' ) )
		);
		const [ first ] = await blockOrder( page );
		const client = await page.context().newCDPSession( page );
		const outcomes = {};

		async function push( targetIndex, text ) {
			await page.evaluate(
				( [ id, index, html ] ) => {
					const recorder = window.__editBatchRecorder;
					const handlers = recorder.handlers[ 'postType/post/' + id ];
					const current = window.wp.data
						.select( 'core/block-editor' )
						.getBlocks();
					const pushed = current.map( ( block, position ) => {
						if ( position !== index ) {
							return block;
						}

						return {
							...block,
							attributes: {
								...block.attributes,
								content:
									window.wp.richText.RichTextData.fromHTMLString(
										html
									),
							},
						};
					} );
					handlers.editRecord( { blocks: pushed } );
				},
				[ post.id, targetIndex, text ]
			);
		}

		async function readFirst() {
			return page.evaluate(
				( id ) =>
					String(
						window.wp.data
							.select( 'core/block-editor' )
							.getBlockAttributes( id ).content
					),
				first
			);
		}

		// Round one: the push changes another paragraph.
		// Round two: the push changes the paragraph being composed in.
		const rounds = [
			{ name: 'pushToAnotherParagraph', index: 1, html: 'Other pushed' },
			{ name: 'pushToTheSameParagraph', index: 0, html: null },
		];
		for ( const round of rounds ) {
			const before = await readFirst();
			await placeCaret( { page }, first, before.length );
			for ( const text of [ 'に', 'にほ', 'にほん' ] ) {
				await client.send( 'Input.imeSetComposition', {
					text,
					selectionStart: text.length,
					selectionEnd: text.length,
				} );
				await page.waitForTimeout( 120 );
			}

			let html = round.html;
			if ( html === null ) {
				html = 'Pushed ' + before;
			}

			await push( round.index, html );
			await page.waitForTimeout( 200 );
			const duringComposition = await page.evaluate( () => {
				const frame = document.querySelector(
					'iframe[name="editor-canvas"]'
				);

				return frame.contentDocument.querySelector(
					'.is-root-container'
				).textContent;
			} );
			await client.send( 'Input.insertText', { text: '日本' } );
			await page.waitForTimeout( 300 );
			outcomes[ round.name ] = {
				firstParagraphBefore: before,
				pageTextWhileComposing: duringComposition,
				firstParagraphAfterCommit: await readFirst(),
			};
		}

		recordFact( 'pushWhileComposing', {
			question:
				'Does a push cancel or damage text that is being composed with an input method?',
			outcomes,
		} );
	} );

	test( 'what load receives for a post with nested blocks', async ( {
		admin,
		page,
		requestUtils,
	} ) => {
		await openPost(
			{ admin, page, requestUtils },
			blocks( paragraph( 'One' ), LIST, GROUP )
		);
		const start = await begin( page );
		const loads = start.startupEvents.filter(
			( event ) => event.call === 'load'
		);
		const postLoad = loads.find( ( event ) => event.name === 'post' );
		const loadedIds = collectClientIds( postLoad.tree );
		const editorIds = collectClientIds( start.editorTree );

		recordFact( 'clientIdsFromLoad', {
			question:
				'Do the blocks passed to load have the clientId values the editor uses afterwards?',
			blocksInLoad: loadedIds.length,
			blocksInEditor: editorIds.length,
			sameIdsInSameOrder:
				JSON.stringify( loadedIds ) === JSON.stringify( editorIds ),
			blockTypesRegisteredAtLoad: postLoad.blockTypesRegistered,
			everyLoadCall: loads.map( ( event ) => ( {
				kind: event.kind,
				name: event.name,
				recordId: event.recordId,
				hasBlocks: event.hasBlocks,
				blocks: collectClientIds( event.tree ).length,
				blockTypesRegistered: event.blockTypesRegistered,
			} ) ),
		} );
	} );
} );
