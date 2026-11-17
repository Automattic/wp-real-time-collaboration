#!/usr/bin/env node
/**
 * Prints the recorded edit batches in tests/fixtures/edit-batches/ as one
 * line per call, so a recording can be read without opening its JSON.
 *
 * Usage:
 *   node tests/tools/print-edit-batches.mjs                 every recording
 *   node tests/tools/print-edit-batches.mjs typing emoji    recordings whose
 *                                                           name contains a word
 *   node tests/tools/print-edit-batches.mjs --startup emoji also the calls made
 *                                                           before the action
 *
 * How to read a line:
 *   [flags] operation | operation sel[start..end]
 *
 *   flags      "level" when the batch opened a new undo step, "cached" and
 *              "undoIgnore" as core-data sent them.
 *   #1a2b      the first four characters of a block's clientId.
 *   RT"..."    a rich text object. A bare "..." is a plain string.
 *   sel[...]   the selection after the batch, as block.attribute@offset.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(
	dirname( fileURLToPath( import.meta.url ) ),
	'..',
	'fixtures',
	'edit-batches'
);

const MAX_TEXT = 60;

/**
 * Shortens a clientId to its first four characters.
 *
 * @param {unknown} clientId A block's clientId, or null.
 * @return {string} The short form.
 */
function shortId( clientId ) {
	if ( 'string' !== typeof clientId ) {
		return String( clientId );
	}

	return clientId.slice( 0, 4 );
}

/**
 * Shortens a long text in the middle.
 *
 * @param {string} text The text.
 * @return {string} The text, at most MAX_TEXT characters long.
 */
function clip( text ) {
	if ( text.length <= MAX_TEXT ) {
		return text;
	}

	const half = Math.floor( ( MAX_TEXT - 1 ) / 2 );

	return text.slice( 0, half ) + '…' + text.slice( text.length - half );
}

/**
 * Formats a recorded value.
 *
 * @param {unknown} value The value as the recorder stored it.
 * @return {string} A short readable form.
 */
function formatValue( value ) {
	if ( value && 'object' === typeof value && '__type' in value ) {
		if ( 'RichTextData' === value.__type ) {
			return 'RT' + JSON.stringify( clip( value.html ) );
		}

		return value.__type;
	}

	if ( 'string' === typeof value ) {
		return JSON.stringify( clip( value ) );
	}

	const json = JSON.stringify( value );

	if ( undefined === json ) {
		return String( value );
	}

	return clip( json );
}

/**
 * Formats a block, with its children, for an insert.
 *
 * @param {Object} block The recorded block.
 * @return {string} A short readable form.
 */
function formatBlock( block ) {
	const name = block.name.replace( /^core\//, '' );
	const parts = [];
	const content = block.attributes?.content;

	if ( undefined !== content ) {
		parts.push( formatValue( content ) );
	}

	for ( const child of block.innerBlocks ?? [] ) {
		parts.push( formatBlock( child ) );
	}

	return `${ name }#${ shortId( block.clientId ) }(${ parts.join( ', ' ) })`;
}

/**
 * Formats one operation of a batch.
 *
 * @param {Object} operation The recorded operation.
 * @return {string} A short readable form.
 */
function formatOperation( operation ) {
	switch ( operation.type ) {
		case 'insert':
			return (
				`insert ${ formatBlock( operation.block ) }` +
				` parent=${ shortId( operation.parent ) }` +
				` before=${ shortId( operation.before ) }`
			);

		case 'remove':
			return `remove #${ shortId( operation.clientId ) }`;

		case 'move':
			return (
				`move #${ shortId( operation.clientId ) }` +
				` parent=${ shortId( operation.parent ) }` +
				` before=${ shortId( operation.before ) }`
			);

		case 'set-attribute':
			return (
				`set-attr #${ shortId( operation.clientId ) }.${
					operation.attribute
				} ` +
				`${ formatValue( operation.previousValue ) } -> ${ formatValue(
					operation.value
				) }`
			);

		case 'set-block-property':
			return (
				`set-prop #${ shortId( operation.clientId ) }.${
					operation.property
				} ` +
				`${ formatValue( operation.previousValue ) } -> ${ formatValue(
					operation.value
				) }`
			);

		case 'set-field':
			return (
				`set-field ${ operation.field } ` +
				`${ formatValue( operation.previousValue ) } -> ${ formatValue(
					operation.value
				) }`
			);

		default:
			return `${ operation.type } ${ clip(
				JSON.stringify( operation )
			) }`;
	}
}

/**
 * Formats one end of a selection.
 *
 * @param {Object|undefined} end The selection end.
 * @return {string} A short readable form.
 */
function formatSelectionEnd( end ) {
	if ( ! end || 0 === Object.keys( end ).length ) {
		return '-';
	}

	let text = shortId( end.clientId );

	// A missing value is recorded as an object, not left out.
	if ( 'string' === typeof end.attributeKey ) {
		text += `.${ end.attributeKey }`;
	}

	if ( 'number' === typeof end.offset ) {
		text += `@${ end.offset }`;
	}

	return text;
}

/**
 * Formats a batch's selection.
 *
 * @param {Object|undefined} selection The recorded selection.
 * @return {string} A short readable form, or an empty string.
 */
function formatSelection( selection ) {
	if ( ! selection ) {
		return '';
	}

	return (
		` sel[${ formatSelectionEnd( selection.selectionStart ) }` +
		`..${ formatSelectionEnd( selection.selectionEnd ) }]`
	);
}

/**
 * Formats one recorded call.
 *
 * @param {Object} event The recorded call.
 * @return {string} One line.
 */
function formatEvent( event ) {
	const record = `${ event.kind }/${ event.name }`;

	if ( 'applyEditBatch' !== event.call ) {
		let line = `(${ event.call }) ${ record }`;

		if ( undefined !== event.recordId ) {
			line += `/${ event.recordId }`;
		}

		if ( Array.isArray( event.tree ) ) {
			line += ` blocks=${ event.tree.length }`;
		}

		return line;
	}

	const batch = event.batch ?? {};
	const flags = [];

	if ( event.openedUndoLevel ) {
		flags.push( 'level' );
	}

	if ( batch.options?.isCached ) {
		flags.push( 'cached' );
	}

	if ( batch.options?.undoIgnore ) {
		flags.push( 'undoIgnore' );
	}

	const operations = ( batch.operations ?? [] ).map( formatOperation );
	let body = '(no operations)';

	if ( operations.length > 0 ) {
		body = operations.join( ' | ' );
	}

	let line = `[${ flags.join( ' ' ) }] ${ body }${ formatSelection(
		batch.selection
	) }`;

	if ( 'postType/post' !== record ) {
		line += ` {${ record }/${ event.recordId }}`;
	}

	return line;
}

const args = process.argv.slice( 2 );
const showStartup = args.includes( '--startup' );
const words = args.filter( ( arg ) => ! arg.startsWith( '--' ) );

const files = readdirSync( FIXTURES )
	.filter( ( file ) => file.endsWith( '.json' ) && 'facts.json' !== file )
	.filter(
		( file ) =>
			0 === words.length ||
			words.some( ( word ) => file.includes( word ) )
	)
	.sort();

for ( const file of files ) {
	const recording = JSON.parse(
		readFileSync( join( FIXTURES, file ), 'utf8' )
	);

	console.log( `\n== ${ recording.scenario }: ${ recording.description }` );

	if ( showStartup ) {
		for ( const event of recording.startupEvents ?? [] ) {
			console.log( `  ${ formatEvent( event ) }` );
		}

		console.log( '  --' );
	}

	for ( const event of recording.events ?? [] ) {
		console.log( `  ${ formatEvent( event ) }` );
	}
}
