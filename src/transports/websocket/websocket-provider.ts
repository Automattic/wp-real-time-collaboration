/**
 * Internal dependencies
 */
import type {
	ConnectionStatus,
	EngineSessionCodec,
	ProviderCreator,
	ProviderCreatorResult,
} from '../../registry/types';
import { ProviderEvents } from '../../registry/events';
import { websocketManager } from './websocket-manager';

interface ProviderOptions {
	room: string;
	session: EngineSessionCodec;
}

/**
 * Provider that moves the engine session codec's updates and awareness over
 * a WebSocket (its server counterpart is the WP_WebSocket_Sync_Server
 * daemon). Push-based: remote edits arrive the instant peers make them.
 */
class WebSocketProvider extends ProviderEvents {
	protected status: ConnectionStatus[ 'status' ] = 'disconnected';

	public constructor( protected options: ProviderOptions ) {
		super();
		websocketManager.registerRoom( {
			room: options.room,
			session: options.session,
			onStatusChange: ( status ) => this.emit( 'status', status ),
		} );
	}

	public destroy(): void {
		websocketManager.unregisterRoom( this.options.room );
		super.destroy();
	}
}

/**
 * Creates the WebSocket provider.
 *
 * @return {ProviderCreator} The provider creator.
 */
export function createWebSocketProvider(): ProviderCreator {
	return async ( { objectType, objectId, session } ) => {
		const room = objectId ? `${ objectType }:${ objectId }` : objectType;
		const provider = new WebSocketProvider( { room, session } );
		const result: ProviderCreatorResult = {
			destroy: () => provider.destroy(),
			on: ( event, callback ) => provider.on( event, callback ),
		};

		return result;
	};
}
