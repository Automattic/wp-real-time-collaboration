/**
 * The errors a transport reports when a room cannot connect or loses its
 * connection.
 *
 * The editor reads an error by its `code` text, never by its class, so
 * these values are part of what the editor understands. Do not rename a
 * code without checking the editor's connection notices.
 */

export enum ConnectionErrorCode {
	AUTHENTICATION_FAILED = 'authentication-failed',
	CONNECTION_EXPIRED = 'connection-expired',
	CONNECTION_LIMIT_EXCEEDED = 'connection-limit-exceeded',
	DOCUMENT_SIZE_LIMIT_EXCEEDED = 'document-size-limit-exceeded',
	ENGINE_MISMATCH = 'engine-mismatch',
	PROTOCOL_MISMATCH = 'protocol-mismatch',
	UNKNOWN_ERROR = 'unknown-error',
}

export class ConnectionError extends Error {
	constructor(
		public code: ConnectionErrorCode = ConnectionErrorCode.UNKNOWN_ERROR,
		message?: string
	) {
		super( message );
		this.name = 'ConnectionError';
	}
}
