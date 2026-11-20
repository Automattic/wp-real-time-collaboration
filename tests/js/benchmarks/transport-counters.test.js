/**
 * Internal dependencies
 */
import {
	attachCounters,
	observeTransport,
	deliveryTransport,
} from '../../benchmarks/transport/lib.mjs';

it( 'maps the current settings radio choices', () => {
	expect( deliveryTransport( 'websocket' ) ).toBe( 'websocket' );
	expect( deliveryTransport( 'polling-webrtc' ) ).toBe( 'http-polling' );
} );

it( 'does not confuse advisory socket traffic with the content transport', () => {
	const events = {};
	const frames = {};
	const page = {
		on: ( event, handler ) => {
			events[ event ] = handler;
		},
	};
	const counters = attachCounters( page );
	events.websocket( {
		on: ( event, handler ) => {
			frames[ event ] = handler;
		},
	} );
	frames.framesent( { payload: '{"type":"advisory"}' } );
	frames.framereceived( { payload: '{"type":"advisory","event":"roster"}' } );
	expect( counters.snapshot().wsFramesSent ).toBe( 1 );
	expect( observeTransport( counters ) ).toBe( 'none' );
	events.request( {
		url: () => 'http://site/wp-rtc/v1/updates',
		postDataBuffer: () => null,
	} );
	expect( observeTransport( counters ) ).toBe( 'http-polling' );
	frames.framesent( { payload: '{"type":"sync","rooms":[]}' } );
	expect( observeTransport( counters ) ).toBe( 'websocket' );
} );
