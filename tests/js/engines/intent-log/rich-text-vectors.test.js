/**
 * JS-side replay of the frozen cross-language rich text vectors.
 *
 * The PHP twin replays `test-vectors/rich-text.json` in
 * `tests/phpunit/wpIntentLogRichText.php`. This file replays the same
 * vectors against the JavaScript codec, so a change to either side that
 * moves text positions fails on that side.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	fieldToHtml,
	htmlToField,
} from '../../../../src/engines/intent-log/rich-text.js';

const vectors = JSON.parse(
	readFileSync(
		join(
			dirname( fileURLToPath( import.meta.url ) ),
			'test-vectors',
			'rich-text.json'
		),
		'utf8'
	)
);

describe( 'frozen rich text vectors (JS replay)', () => {
	it( 'has cases', () => {
		assert.ok( vectors.cases.html.length > 0 );
		assert.ok( vectors.cases.field.length > 0 );
	} );

	for ( const vectorCase of vectors.cases.html ) {
		it( `reproduces the html case: ${ JSON.stringify(
			vectorCase.html
		) }`, () => {
			const field = htmlToField( vectorCase.html );
			assert.deepEqual( field, vectorCase.field );
			assert.equal( fieldToHtml( field ), vectorCase.serialized );
		} );
	}

	for ( const vectorCase of vectors.cases.field ) {
		it( `reproduces the field case: ${ JSON.stringify(
			vectorCase.field
		) }`, () => {
			const serialized = fieldToHtml( vectorCase.field );
			assert.equal( serialized, vectorCase.serialized );
			assert.deepEqual( htmlToField( serialized ), vectorCase.reparsed );
		} );
	}
} );
