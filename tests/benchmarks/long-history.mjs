/**
 * Runs the long-history benchmark in the tests environment and prints a
 * table. See tests/benchmarks/long-history.php for what it measures.
 *
 *   npm run bench -- --suite=long-history
 *   npm run bench -- --suite=long-history --history=0,450,950 --samples=30 --json=out.json
 *
 * Arguments (bare key=value tokens, as bench.mjs forwards them):
 *   history=  comma-separated history sizes, in accepted edits
 *   samples=  measured requests per size (default 20)
 *   json=     also write the full report to this file
 *
 * Needs the tests wp-env running. Override the wp-env config with
 * BENCH_WPENV_CONFIG (default .wp-env.tests.json).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const options = {};
for ( const token of process.argv.slice( 2 ) ) {
	const match = /^-{0,2}([a-z0-9-]+)=(.*)$/.exec( token );
	if ( match ) {
		options[ match[ 1 ] ] = match[ 2 ];
	}
}

const ENV_CONFIG = process.env.BENCH_WPENV_CONFIG ?? '.wp-env.tests.json';
const ENV_CWD = `wp-content/plugins/${ path.basename( process.cwd() ) }`;

function wp( wpArgs ) {
	return spawnSync(
		'npx',
		[
			'@wordpress/env',
			'--config',
			ENV_CONFIG,
			'run',
			'cli',
			`--env-cwd=${ ENV_CWD }`,
			'wp',
			...wpArgs,
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
}

// PHPUnit leaves both plugins inactive, and the benchmark needs them.
wp( [ 'plugin', 'activate', 'presence-api', 'wp-real-time-collaboration' ] );

const forwarded = [];
for ( const key of [ 'history', 'samples' ] ) {
	if ( options[ key ] !== undefined ) {
		forwarded.push( `${ key }=${ options[ key ] }` );
	}
}

const run = wp( [
	'eval-file',
	'tests/benchmarks/long-history.php',
	...forwarded,
] );
const line = ( run.stdout || '' )
	.split( '\n' )
	.find( ( candidate ) => candidate.startsWith( '{"scope"' ) );
if ( 0 !== run.status || ! line ) {
	console.error( run.stdout );
	console.error( run.stderr );
	console.error( 'long-history: the benchmark did not finish.' );
	process.exit( 1 );
}

const report = JSON.parse( line );
console.log( report.scope );
console.log( '' );
console.log(
	'| history | stored rows | stored bytes | commit p50 ms | commit p90 ms | idle read p50 ms | idle read p90 ms |'
);
console.log( '|---|---|---|---|---|---|---|' );
for ( const row of report.results ) {
	console.log(
		`| ${ row.history } | ${ row.stored_rows } | ${ row.stored_bytes } | ${ row.commit_p50_ms } | ${ row.commit_p90_ms } | ${ row.read_p50_ms } | ${ row.read_p90_ms } |`
	);
}

if ( options.json ) {
	writeFileSync( options.json, JSON.stringify( report, null, 2 ) + '\n' );
	console.log( `\nfull report: ${ options.json }` );
}
