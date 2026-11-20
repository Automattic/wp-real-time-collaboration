<?php
/**
 * WP_RTC_Transport_Registry class
 *
 * @package WPRealTimeCollaboration
 */

if ( ! class_exists( 'WP_RTC_Transport_Registry' ) ) {

	/**
	 * Registers collaborative-editing transports by slug and decides which
	 * one the server announces as active.
	 *
	 * Mirrors WP_RTC_Engine_Registry: built-in transports register here, a
	 * filter lets plugins add more, and a single site config value picks the
	 * active one. Adding a transport is a matter of dropping a sibling class
	 * under `transports/` and registering it — selection code never changes.
	 *
	 * @since 7.2.0
	 * @access private
	 */
	class WP_RTC_Transport_Registry {
		/**
		 * Registered transports, keyed by slug (insertion order preserved).
		 *
		 * @since 7.2.0
		 * @var array<string, WP_RTC_Transport>
		 */
		private array $transports = array();

		/**
		 * Constructor. Registers the built-in transports, then lets plugins
		 * register more via the `wp_rtc_transports` filter.
		 *
		 * @since 7.2.0
		 *
		 * @param WP_RTC_Storage         $storage Storage backend.
		 * @param WP_RTC_Engine_Registry $engines Engine registry the
		 *                                         transports drive rooms through.
		 */
		public function __construct( WP_RTC_Storage $storage, WP_RTC_Engine_Registry $engines ) {
			/**
			 * Filters the registered sync transports.
			 *
			 * The plugin registers its own transports here, and other code
			 * can add more. With none registered a session has no transport
			 * and the editor falls back to the post lock.
			 *
			 * Return an array of WP_RTC_Transport instances.
			 *
			 * @since 7.2.0
			 *
			 * @param WP_RTC_Transport[]     $transports Transports to register.
			 * @param WP_RTC_Storage         $storage    Storage backend.
			 * @param WP_RTC_Engine_Registry $engines    Engine registry.
			 */
			$extra = apply_filters( 'wp_rtc_transports', array(), $storage, $engines );
			if ( is_array( $extra ) ) {
				foreach ( $extra as $transport ) {
					if ( $transport instanceof WP_RTC_Transport ) {
						$this->register( $transport );
					}
				}
			}
		}

		/**
		 * Registers a transport (last registration of a slug wins).
		 *
		 * @since 7.2.0
		 *
		 * @param WP_RTC_Transport $transport Transport instance.
		 * @return void
		 */
		public function register( WP_RTC_Transport $transport ): void {
			$this->transports[ $transport->get_slug() ] = $transport;
		}

		/**
		 * Returns a registered transport by slug.
		 *
		 * @since 7.2.0
		 *
		 * @param string $slug Transport slug.
		 * @return WP_RTC_Transport|null Transport, or null if not registered.
		 */
		public function get_transport( string $slug ): ?WP_RTC_Transport {
			return $this->transports[ $slug ] ?? null;
		}

		/**
		 * Returns all registered transports.
		 *
		 * @since 7.2.0
		 *
		 * @return array<string, WP_RTC_Transport> Transports keyed by slug.
		 */
		public function get_transports(): array {
			return $this->transports;
		}

		/**
		 * The active transport slug: the configured one when registered,
		 * otherwise any registered transport, or '' when the registry is
		 * empty (no transport plugin active → RTC disabled).
		 *
		 * @since 7.2.0
		 *
		 * @return string Active transport slug, or ''.
		 */
		public function get_active_slug(): string {
			$configured = wp_rtc_get_transport_slug();
			if ( isset( $this->transports[ $configured ] ) ) {
				return $configured;
			}
			$slugs = array_keys( $this->transports );
			return $slugs[0] ?? '';
		}

		/**
		 * The transport slugs to announce to clients, active FIRST. The
		 * client picks the first announced slug it can provide, so ordering
		 * expresses the server's preference while still degrading to any
		 * mutually-supported transport.
		 *
		 * @since 7.2.0
		 *
		 * @return string[] Ordered transport slugs.
		 */
		public function get_announced_slugs(): array {
			$active = $this->get_active_slug();
			if ( '' === $active ) {
				return array();
			}
			$slugs = array( $active );
			foreach ( array_keys( $this->transports ) as $slug ) {
				if ( $slug !== $active ) {
					$slugs[] = $slug;
				}
			}
			return $slugs;
		}

		/**
		 * Registers the routes of every transport (all are reachable; the
		 * announcement decides which the client uses).
		 *
		 * @since 7.2.0
		 *
		 * @return void
		 */
		public function register_all_routes(): void {
			foreach ( $this->transports as $transport ) {
				$transport->register_routes();
			}
		}
	}
}
