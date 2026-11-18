/**
 * External dependencies
 */
import { describe, expect, it } from '@jest/globals';

/**
 * Internal dependencies
 */
import { createIntent } from '../../../src/engines/intent-log/intents.js';
import {
	createServer,
	serverDocAt,
	serverIngestBatch,
} from '../../../src/engines/intent-log/rebase.js';
import type { IntentEnvelope } from '../../../src/engines/intent-log/engine-types';
import { contentText, documentFromBlocks, paragraph } from './helpers';

/*
 * Known defect.
 *
 * A person's letters are written against their own text: the text they
 * started from plus the letters they typed before. When someone else
 * changed the same paragraph in the meantime, the server cannot tell
 * where such a letter belongs, so it sets the typing aside for review
 * (`frame-conflict`, rule 5 in src/engines/intent-log/SPEC.md).
 *
 * The server only remembers the person's earlier letters within one
 * request. When the letters arrive one request each, it forgets that the
 * earlier ones are part of the text the next one was typed in, and puts
 * the next one at the wrong place without asking anyone.
 *
 * This happens over WebSocket, where every letter is its own message.
 * A window that was offline sends everything it typed that way when it
 * comes back. Two people typing a few characters apart can hit it too.
 */

const BOB_TYPES = 'blue blue blue ';
const ALICE_TYPES = ' red';

/**
 * One typed letter.
 *
 * @param actorId The person.
 * @param offset  Where the letter goes, in that person's own text.
 * @param text    The letter.
 * @param baseSeq The position in the history the person had seen.
 * @return The edit.
 */
function letter(
	actorId: string,
	offset: number,
	text: string,
	baseSeq: number
): IntentEnvelope {
	return createIntent(
		'insert_text',
		{ syncId: 'p1', field: 'content', offset, text },
		{ actorId, baseSeq, intentId: `${ actorId }#${ offset }` }
	);
}

/**
 * Sends Alice's and Bob's typing to a new server.
 *
 * Alice is online. She types " red" at the end of "Alpha one", and each
 * letter is answered before the next. Bob was offline the whole time. He
 * typed "blue blue blue " at the start, having seen none of Alice's
 * letters.
 *
 * @param oneRequestPerLetter Whether Bob's letters arrive one request
 *                            each, or all in one request.
 * @return The paragraph's text on the server, and how many of Bob's
 *         letters were set aside.
 */
function run( oneRequestPerLetter: boolean ) {
	const server = createServer(
		documentFromBlocks( [ paragraph( 'p1', 'Alpha one' ) ] )
	);

	[ ...ALICE_TYPES ].forEach( ( text, index ) => {
		serverIngestBatch( server, [
			letter( 'alice', 'Alpha one'.length + index, text, index ),
		] );
	} );

	const bobs = [ ...BOB_TYPES ].map( ( text, index ) =>
		letter( 'bob', index, text, 0 )
	);

	if ( oneRequestPerLetter ) {
		for ( const one of bobs ) {
			serverIngestBatch( server, [ one ] );
		}
	} else {
		serverIngestBatch( server, bobs );
	}

	return {
		text: contentText(
			serverDocAt( server, server.firstSeq + server.log.length ),
			'p1'
		),
		setAside: server.proposals.length,
	};
}

/**
 * Whether the letters Bob typed in a row are still in a row: the text is
 * Alice's result with some first part of Bob's typing in front of it.
 *
 * @param text The paragraph's text.
 * @return Whether nothing of Bob's is out of place.
 */
function bobsLettersAreInARow( text: string ): boolean {
	const rest = `Alpha one${ ALICE_TYPES }`;

	return (
		text.endsWith( rest ) &&
		BOB_TYPES.startsWith( text.slice( 0, text.length - rest.length ) )
	);
}

describe( 'typing sent one letter per request, after someone else changed the paragraph', () => {
	it( 'is set aside as a whole when the letters arrive in one request', () => {
		const { text, setAside } = run( false );

		expect( text ).toBe( `Alpha one${ ALICE_TYPES }` );
		expect( setAside ).toBe( BOB_TYPES.length );
	} );

	it.failing(
		'is not put at the wrong place when each letter arrives in its own request',
		() => {
			const { text } = run( true );

			// Today: "blue blueAlph blue a one red", and nothing is set
			// aside. The tenth letter was typed at offset 9 of Bob's
			// text. The server reads that as offset 9 of the text Alice
			// typed in, and moves it along with her four letters.
			expect( bobsLettersAreInARow( text ) ).toBe( true );
		}
	);
} );
