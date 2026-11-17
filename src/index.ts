/**
 * The plugin's browser entry. It registers the engine, the transports,
 * and the conflict review screens, in this order:
 *
 *   - The engine (intent-log) registers with the plugin's own engine
 *     registry (src/registry/engines.ts).
 *   - The transports (http-polling, websocket) register with the plugin's
 *     own transport registry (src/registry/transports.ts).
 *   - The engine the server announced is handed to core-data as its sync
 *     provider (src/editor/register.ts). This is the plugin's only
 *     registration with Gutenberg.
 *
 * Without a provider the editor finds nothing to sync with and falls back
 * to the classic post lock.
 */

/**
 * Internal dependencies
 */
import {
	isComposing,
	isTypingIn,
	readEditorBlock,
	watchComposition,
} from './editor/editor-state';
import { createIntentLogProvider } from './editor/provider';
import { registerEngineWithEditor } from './editor/register';
import {
	INTENT_LOG_ENGINE_PROTOCOL,
	INTENT_LOG_ENGINE_SLUG,
} from './engines/intent-log-session';
import { registerConflictSource } from './review';
import { createHttpPollingProvider } from './providers/http-polling/http-polling-provider';
import { createWebSocketProvider } from './providers/websocket/websocket-provider';
import { bootstrapSlowAwareness } from './awareness';
import { registerSyncEngine } from './registry/engines';
import { registerSyncTransport } from './registry/transports';

// The engine: how edits from several people are combined.
registerSyncEngine( {
	slug: INTENT_LOG_ENGINE_SLUG,
	protocolVersion: INTENT_LOG_ENGINE_PROTOCOL,
	createProvider: ( context ) => {
		const provider = createIntentLogProvider( context, {
			isComposing,
			isTypingIn,
			readEditorBlock,
		} );

		// The review screens show the edits this engine set aside.
		registerConflictSource( provider.conflicts );
		watchComposition();

		return provider;
	},
} );

// Transports: how updates move. Each carries the slug and the protocol
// version the server announces.
registerSyncTransport( {
	slug: 'http-polling',
	protocolVersion: 1,
	create: createHttpPollingProvider,
} );
registerSyncTransport( {
	slug: 'websocket',
	protocolVersion: 1,
	create: createWebSocketProvider,
} );

// Hand the announced engine to the editor, after the engine and the
// transports are registered and before the editor loads its first record.
registerEngineWithEditor();

// Slow awareness (block presence on a slow cadence), when the site has
// turned it on. See src/awareness/.
bootstrapSlowAwareness();
