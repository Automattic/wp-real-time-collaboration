/**
 * External dependencies
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from '@jest/globals';
import type { EngineDisposition } from '../../../src/registry/types';

/**
 * Internal dependencies
 */
import {
	createIntentLogSession,
	INTENT_LOG_UPDATE_TYPES,
	type IntentLogSession,
} from '../../../src/engines/intent-log-session';
import { createDocument } from '../../../src/engines/intent-log/document.js';
import { createIntent } from '../../../src/engines/intent-log/intents.js';
import type { EngineDocument } from '../../../src/engines/intent-log/engine-types';
import { contentText } from '../known-defects/helpers';

/*
 * The server can replace a room's history with one fresh copy of the
 * document (a reset). The tab cannot take it while an edit that was sent
 * has no answer. Keys typed during that wait are not sent, so they cannot
 * make the wait longer, and the wait has a time limit. A person who keeps
 * typing still sees everyone else's changes.
 */

const RESET_POSITION = 40;
const ROUNDS = 60;

/**
 * Hands the server's answers to the session.
 *
 * @param session The session.
 * @param answers One answer per edit.
 */
function answer( session: IntentLogSession, answers: EngineDisposition[] ) {
	if ( ! session.receiveDispositions ) {
		throw new Error( 'The session takes no answers.' );
	}

	session.receiveDispositions( answers );
}

/**
 * The session's current document.
 *
 * @param session The session.
 * @return The document.
 */
function documentOf( session: IntentLogSession ): EngineDocument {
	const doc = session.getDocument();
	if ( ! doc ) {
		throw new Error( 'The session has no document yet.' );
	}

	return doc;
}

describe( 'a reset while the person keeps typing', () => {
	beforeEach( () => {
		jest.useFakeTimers();
	} );

	afterEach( () => {
		jest.useRealTimers();
	} );

	it( 'takes the reset and shows incoming changes', () => {
		const session = createIntentLogSession( {
			userId: 1,
			clientId: 11,
		} );
		session.receiveUpdate( {
			data: JSON.stringify( {
				doc: createDocument( [
					{
						syncId: 'p1',
						blockType: 'core/paragraph',
						text: 'Hello',
					},
				] ),
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );

		const typeOneLetter = () =>
			session.author( 'insert_text', {
				syncId: 'p1',
				field: 'content',
				offset: contentText( documentOf( session ), 'p1' ).length,
				text: 'x',
			} );

		// One edit is waiting for its answer when the reset arrives.
		let waiting = typeOneLetter();
		session.takeUpdatesToSend( { maxBytes: Infinity } );
		session.receiveUpdate( {
			data: JSON.stringify( {
				doc: createDocument( [
					{
						syncId: 'p1',
						blockType: 'core/paragraph',
						text: 'Hello',
					},
				] ),
				seq: RESET_POSITION,
			} ),
			type: INTENT_LOG_UPDATE_TYPES.SNAPSHOT,
		} );

		// Another person's change arrives right behind the reset.
		session.receiveUpdate( {
			data: JSON.stringify(
				createIntent(
					'insert_text',
					{
						syncId: 'p1',
						field: 'content',
						offset: 0,
						text: 'Bob was here. ',
					},
					{
						actorId: 'u2c22',
						baseSeq: RESET_POSITION,
						intentId: 'bob#1',
					}
				)
			),
			type: INTENT_LOG_UPDATE_TYPES.INTENT,
		} );

		// The person keeps typing for a minute. Each answer comes
		// back after the next letter was typed, so one edit is
		// always waiting. The server refuses edits made before the
		// reset, which is what "stale-base" means.
		for ( let round = 0; round < ROUNDS; round++ ) {
			const next = typeOneLetter();
			answer( session, [
				{
					intentId: waiting.intentId,
					status: 'voided',
					reason: 'stale-base',
				},
			] );
			waiting = next;
			jest.advanceTimersByTime( 1000 );
		}

		// The tab has taken the reset and shows Bob's change.
		expect( session.getSeq() ).toBeGreaterThanOrEqual( RESET_POSITION );
		expect( contentText( documentOf( session ), 'p1' ) ).toContain(
			'Bob was here.'
		);
	} );
} );
