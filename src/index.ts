/**
 * Client entry: registers this plugin's sync engine, its transports, and
 * the conflict review screens.
 *
 *   - The engine (intent-log) registers with Gutenberg's `@wordpress/sync`
 *     package, through its private `registerSyncEngine`. The bundled
 *     core-data finds an engine only there.
 *   - The transports (http-polling, websocket) register with the plugin's
 *     own registry (src/registry/transports.ts).
 *   - The conflict review screens (src/review/) are fed by the conflict
 *     source the engine adapter registers when it creates an engine.
 *
 * Without an engine the editor finds nothing to connect with and falls
 * back to the classic post lock.
 *
 * Core-data receives record loads, edits, saves and cleanup through the
 * entity adapter registered below. The bundled bridge preserves each engine's
 * snapshots, undo metadata, connection status and conflict-review handlers.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.sync.
import { privateApis } from '@wordpress/sync';

/**
 * Internal dependencies
 */
import { unlock } from './lock-unlock';
import { createIntentLogEngineAdapter } from './engines/intent-log-adapter';
import './review';
import { createHttpPollingProvider } from './providers/http-polling/http-polling-provider';
import { createWebSocketProvider } from './providers/websocket/websocket-provider';
import { bootstrapSlowAwareness } from './awareness';
import { registerPluginEntitySync } from './entity-sync';
import { registerSyncTransport } from './registry/transports';

const { registerSyncEngine } = unlock( privateApis );

// Engines: how concurrent edits merge.
registerSyncEngine( createIntentLogEngineAdapter() );

// Transports: how updates move. Each carries the slug + protocol the server
// announces and negotiates against.
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

// Core-data receives lifecycle events through the plugin adapter in every mode.
registerPluginEntitySync();

// Slow awareness (block presence on a slow cadence), when the site has
// turned it on; see src/awareness/.
bootstrapSlowAwareness();
