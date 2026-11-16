/**
 * Checks that the stored test vectors match what the generators produce.
 *
 *   node tests/tools/check-vectors.mjs
 *
 * The JavaScript engine core and its PHP copy are kept equal through JSON
 * vector files, stored twice: once for Jest and once for PHPUnit. This
 * script runs each generator again and compares its output with both
 * stored copies, byte for byte. It exits with code 1 on any difference.
 *
 * A difference means one of two things. The engine core changed and the
 * vectors were not regenerated, or the vectors were edited by hand.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
	path.dirname( fileURLToPath( import.meta.url ) ),
	'../..'
);

const VECTORS = [
	{ generator: 'generate-planner-vectors.js', file: 'planner.json' },
	{ generator: 'generate-rich-text-vectors.js', file: 'rich-text.json' },
	{ generator: 'generate-sync-id-vectors.js', file: 'sync-id.json' },
];

const COPIES = [
	'tests/js/engines/intent-log/test-vectors',
	'tests/phpunit/test-vectors',
];

let failures = 0;
for ( const { generator, file } of VECTORS ) {
	const fresh = execFileSync(
		process.execPath,
		[ '--no-warnings', path.join( root, 'tests/tools', generator ) ],
		{ cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
	);
	for ( const copy of COPIES ) {
		const stored = readFileSync( path.join( root, copy, file ), 'utf8' );
		if ( stored === fresh ) {
			console.log( `ok       ${ copy }/${ file }` );
			continue;
		}

		failures++;
		console.error(
			`DIFFERS  ${ copy }/${ file } does not match the output of tests/tools/${ generator }`
		);
	}
}

if ( failures > 0 ) {
	console.error(
		`\n${ failures } stored vector file(s) differ from fresh output. ` +
			'If the engine core changed on purpose, regenerate both copies. See tests/tools/README.md.'
	);
	process.exit( 1 );
}
