<?php
/**
 * WP_Sync_Connection class
 *
 * @package GutenbergSyncEngines
 * @since n.e.x.t
 */

if ( ! class_exists( 'WP_Sync_Connection' ) ) {

	/**
	 * One client connection to the sync daemon, independent of the wire
	 * format spoken over it.
	 *
	 * This is the socket half of a connection: the stream, the read and
	 * write buffers, and generic HTTP request parsing. Everything that
	 * depends on the wire format (what a completed handshake looks like,
	 * what an inbound message is, how a payload reaches the browser, how
	 * a keepalive is written) is in the subclass.
	 *
	 * The one subclass is WP_WebSocket_Connection (RFC 6455).
	 *
	 * @since n.e.x.t
	 * @access private
	 */
	abstract class WP_Sync_Connection {
		/**
		 * Maximum size (in bytes) of an HTTP request head.
		 *
		 * @since n.e.x.t
		 * @var int
		 */
		const MAX_REQUEST_HEAD_SIZE = 16384; // 16 KB.

		/**
		 * Underlying stream resource.
		 *
		 * @since n.e.x.t
		 * @var resource
		 */
		private $stream;

		/**
		 * Buffered bytes read from the socket, not yet consumed.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		private string $read_buffer = '';

		/**
		 * Buffered bytes waiting to be written to the socket.
		 *
		 * @since n.e.x.t
		 * @var string
		 */
		private string $write_buffer = '';

		/**
		 * Whether the framing handshake has completed.
		 *
		 * @since n.e.x.t
		 * @var bool
		 */
		private bool $is_open = false;

		/**
		 * Whether the connection has been closed.
		 *
		 * @since n.e.x.t
		 * @var bool
		 */
		private bool $is_closed = false;

		/**
		 * Constructor.
		 *
		 * @since n.e.x.t
		 *
		 * @param resource $stream Accepted client stream (non-blocking).
		 */
		public function __construct( $stream ) {
			$this->stream = $stream;
			stream_set_blocking( $stream, false );
		}

		/**
		 * Gets the underlying stream resource.
		 *
		 * @since n.e.x.t
		 *
		 * @return resource Stream resource.
		 */
		public function get_stream() {
			return $this->stream;
		}

		/**
		 * Whether the framing handshake has completed.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True once the connection is ready to carry traffic.
		 */
		public function is_open(): bool {
			return $this->is_open && ! $this->is_closed;
		}

		/**
		 * Whether the connection has been closed.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True if closed.
		 */
		public function is_closed(): bool {
			return $this->is_closed;
		}

		/**
		 * Whether bytes are waiting to be flushed to the socket.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool True if the write buffer is non-empty.
		 */
		public function has_pending_writes(): bool {
			return '' !== $this->write_buffer;
		}

		/**
		 * Marks the framing handshake complete.
		 *
		 * @since n.e.x.t
		 */
		protected function mark_open(): void {
			$this->is_open = true;
		}

		/**
		 * Reads available bytes from the socket into the buffer.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool False when the peer closed the connection.
		 */
		public function read_from_socket(): bool {
			if ( $this->is_closed ) {
				return false;
			}

			$data = fread( $this->stream, 65536 );

			if ( false === $data ) {
				return ! feof( $this->stream );
			}

			if ( '' === $data ) {
				return ! feof( $this->stream );
			}

			$this->read_buffer .= $data;

			return true;
		}

		/**
		 * Bytes read from the socket but not yet consumed.
		 *
		 * The request head is stripped as it is parsed, so whatever follows
		 * it (the client's first frames) is what this returns.
		 *
		 * @since n.e.x.t
		 *
		 * @return string Buffered bytes.
		 */
		public function buffered_bytes(): string {
			return $this->read_buffer;
		}

		/**
		 * Consumes bytes already in the read buffer.
		 *
		 * @since n.e.x.t
		 *
		 * @param int $length Number of bytes to take.
		 * @return string The consumed bytes, or '' when fewer are buffered.
		 */
		protected function take_buffered( int $length ): string {
			if ( $length <= 0 || strlen( $this->read_buffer ) < $length ) {
				return '';
			}

			$take              = substr( $this->read_buffer, 0, $length );
			$this->read_buffer = substr( $this->read_buffer, $length );

			return $take;
		}

		/**
		 * Attempts to parse a complete HTTP request head from the buffer.
		 *
		 * The head ends at the blank line; what follows it stays buffered
		 * for the framing to read.
		 *
		 * @since n.e.x.t
		 *
		 * @return array{method: string, path: string, query: array<string, string>, headers: array<string, string>}|null|WP_Error
		 *         Parsed request, null when the head is incomplete, or WP_Error on a malformed one.
		 */
		public function parse_handshake_request() {
			$head_end = strpos( $this->read_buffer, "\r\n\r\n" );

			if ( false === $head_end ) {
				if ( strlen( $this->read_buffer ) > self::MAX_REQUEST_HEAD_SIZE ) {
					return new WP_Error( 'sync_request_head_too_large', 'Request head too large.' );
				}

				return null;
			}

			$raw_head          = substr( $this->read_buffer, 0, $head_end );
			$this->read_buffer = substr( $this->read_buffer, $head_end + 4 );

			$lines        = explode( "\r\n", $raw_head );
			$request_line = array_shift( $lines );
			$parts        = explode( ' ', $request_line );

			if ( count( $parts ) < 3 ) {
				return new WP_Error( 'sync_bad_request', 'Malformed request line.' );
			}

			$method      = strtoupper( $parts[0] );
			$request_uri = $parts[1];
			$path        = (string) wp_parse_url( $request_uri, PHP_URL_PATH );
			$query_str   = (string) wp_parse_url( $request_uri, PHP_URL_QUERY );

			$query = array();
			if ( '' !== $query_str ) {
				parse_str( $query_str, $query );
			}

			$headers = array();
			foreach ( $lines as $line ) {
				$colon = strpos( $line, ':' );
				if ( false === $colon ) {
					continue;
				}

				$name             = strtolower( trim( substr( $line, 0, $colon ) ) );
				$headers[ $name ] = trim( substr( $line, $colon + 1 ) );
			}

			return array(
				'headers' => $headers,
				'method'  => $method,
				'path'    => $path,
				'query'   => $query,
			);
		}

		/**
		 * Sends a complete plain HTTP response, for answers given before
		 * the handshake: a health check, a rejection.
		 *
		 * @since n.e.x.t
		 *
		 * @param int    $status_code HTTP status code.
		 * @param string $reason      HTTP reason phrase.
		 * @param string $body        Response body.
		 */
		public function send_http_response( int $status_code, string $reason, string $body = '' ): void {
			$response = sprintf( "HTTP/1.1 %d %s\r\n", $status_code, $reason )
				. "Content-Type: text/plain\r\n"
				. "Cache-Control: no-store\r\n"
				. 'Content-Length: ' . strlen( $body ) . "\r\n"
				. "Connection: close\r\n\r\n"
				. $body;

			$this->queue_write( $response );
		}

		/**
		 * Writes a liveness probe in this framing.
		 *
		 * The daemon calls this on its ping tick. The name is the generic
		 * one; the framing writes the bytes its own protocol uses for it.
		 *
		 * @since n.e.x.t
		 */
		final public function send_keepalive(): void {
			$this->send_ping();
		}

		/**
		 * Queues bytes for writing and attempts an immediate flush.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $data Bytes to write.
		 */
		protected function queue_write( string $data ): void {
			if ( $this->is_closed ) {
				return;
			}

			$this->write_buffer .= $data;
			$this->flush_writes();
		}

		/**
		 * Flushes as much of the write buffer as the socket accepts.
		 *
		 * @since n.e.x.t
		 *
		 * @return bool False if the connection failed while writing.
		 */
		public function flush_writes(): bool {
			if ( $this->is_closed || '' === $this->write_buffer ) {
				return true;
			}

			// Intentional silencing: a peer disconnect mid-write raises a
			// warning; the false return value is handled below.
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$written = @fwrite( $this->stream, $this->write_buffer );

			if ( false === $written ) {
				$this->close();
				return false;
			}

			$this->write_buffer = substr( $this->write_buffer, $written );

			return true;
		}

		/**
		 * Closes the underlying stream.
		 *
		 * @since n.e.x.t
		 */
		public function close(): void {
			if ( $this->is_closed ) {
				return;
			}

			$this->is_closed = true;
			$this->is_open   = false;

			if ( is_resource( $this->stream ) ) {
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				@fclose( $this->stream );
			}
		}

		/**
		 * Completes the framing handshake for a parsed request.
		 *
		 * @since n.e.x.t
		 *
		 * @param array $request Parsed request head.
		 * @param array $context Framing context, for values the daemon has
		 *                       already resolved from the request.
		 * @return true True once the connection is open.
		 */
		abstract public function accept_request( array $request, array $context = array() );

		/**
		 * Every complete inbound message the client has sent.
		 *
		 * @since n.e.x.t
		 *
		 * @return array<int, array<string, mixed>>|WP_Error Messages, or WP_Error on a protocol violation.
		 */
		abstract public function read_messages();

		/**
		 * Delivers one application payload to the client.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload UTF-8 text payload.
		 */
		abstract public function send_text( string $payload ): void;

		/**
		 * Writes this framing's liveness probe.
		 *
		 * Reached through send_keepalive(), which is what the daemon calls.
		 *
		 * @since n.e.x.t
		 *
		 * @param string $payload Optional payload, where the framing has one.
		 */
		abstract public function send_ping( string $payload = '' ): void;

		/**
		 * Ends the connection, carrying a close code and reason where the
		 * framing has them.
		 *
		 * @since n.e.x.t
		 *
		 * @param int    $code   Close status code.
		 * @param string $reason Optional close reason.
		 */
		abstract public function send_close( int $code = 1000, string $reason = '' ): void;
	}
}
