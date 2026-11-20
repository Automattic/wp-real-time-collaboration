# Changelog

Significant changes to this plugin, newest first: new features, new
settings or extension points, and behavior that is removed or works
differently. Bug fixes, tests, developer tooling, refactors, and docs are
not listed here as highlights. Add entries under **Unreleased** as part
of the change itself; when a version ships they move under its heading,
followed by the full list of pull requests merged since the previous
release, which the release script generates from the commit history.

## Unreleased

### Added

- An on/off switch for real-time collaboration on the Settings →
  Collaboration screen, stored in the `wp_rtc_enabled` option. Saving it
  also switches Gutenberg's real-time collaboration experiment, which
  the bundled Gutenberg still reads.
- The `wp_rtc_storage` filter, to substitute another storage backend.
- This plugin was created from `gutenberg-sync-engines` at commit
  `9f5267b8914db5c8a72eff19aa9c75c7b8d63bf5`. It keeps the intent-log
  engine, the polling and WebSocket transports, the advisory channel,
  and the conflict review screens.

### Changed

- A tab that edits alone now sends its edits to the room, at most once
  per polling interval. It used to keep them in the browser until
  someone else arrived, a save, or the tab going hidden.
- An edit sent over a WebSocket that closes before the server answers
  is sent again, over polling or the next socket. It used to stay on the
  sender's screen only.
- The contract between an engine's session and a transport changed
  (`src/registry/types.ts`): the session keeps all unsent updates and
  the transport asks for them (`takeUpdatesToSend`, `connectionLost`,
  `receiveUpdates`, `onWorkWaiting`). `onLocalUpdate`,
  `getInitialUpdates`, and the compaction and recovery update methods
  are gone.
- The plugin now owns the server side of collaborative editing: the
  engine and transport contracts and registries, room names and
  permissions, the REST routes, and the settings printed for the
  browser. They used to come from the bundled Gutenberg.
- Four classes have new names, so they no longer clash with a released
  Gutenberg: `WP_RTC_Storage` (was `WP_Sync_Storage`),
  `WP_RTC_Post_Meta_Storage`, `WP_RTC_Config`, and
  `WP_RTC_HTTP_Polling_Sync_Server`. Code that implements the storage
  interface or registers a transport must use the new names.
- Gutenberg's `__unstable_wp_sync_storage` filter no longer changes the
  plugin's storage. Use `wp_rtc_storage`.
- WebSocket, with polling as its backup, is the default transport. A
  site that has set no sync daemon address is taken to have no daemon:
  its tabs do not try the socket and poll, as before. A site that
  defines `WP_RTC_WEBSOCKET_HOST` or `WP_RTC_WEBSOCKET_PORT`, or has
  entered a daemon address, and has never chosen a transport, now uses
  the socket. Choose "Polling" on the settings screen to keep polling.
- The intent-log protocol is version 3. Each stored edit carries the
  room's position after it (`seq`), a request must name its protocol
  version, and each row of a request gets its own answer. A browser tab
  loaded before the update is refused and falls back to the post lock
  until it is reloaded. A room that still holds edits from an older
  version is reset to the saved post when it is first opened, so edits
  in it that were never saved are lost.
- Every name the plugin owns now starts with the plugin's own prefix.
  The names from the plugin this one was created from, and the ones
  taken over from Gutenberg's sync code, are gone. **The stored
  settings reset**: choose the transport, the daemon address and the
  other options again on the settings screen. Rooms kept by the fallback
  storage start again from the saved post. What changed:
  - Options, filters, actions and functions: `gutenberg_sync_engines_*`
    and `wp_sync_*` are now `wp_rtc_*` (for example the `wp_rtc_engines`
    and `wp_rtc_transports` filters and the `wp_rtc_engine` option).
  - Classes and interfaces: `Gutenberg_Sync_Engines_*` and `WP_Sync_*`
    are now `WP_RTC_*` (for example `WP_RTC_Engine` and
    `WP_RTC_Transport`). The intent-log engine's `WP_Intent_Log_*` and
    the `WP_WebSocket_*` classes keep their names.
  - Constants: `WP_SYNC_WEBSOCKET_*` and `GUTENBERG_SYNC_ENGINES_*` are
    now `WP_RTC_*` (for example `WP_RTC_WEBSOCKET_ACCESS_TOKEN_SECRET`).
    A `wp-config.php` that defines the old ones must be updated.
  - REST routes: `wp-sync/v1` and `gutenberg-sync-engines/v1` are now
    `wp-rtc/v1`.
  - The WebSocket subprotocol is `wp-rtc`, with the token sent as
    `wp-rtc-token.<token>`. A relay copied from
    `examples/advisory-relay/` must be updated.
  - The text domain is `wp-real-time-collaboration`.
  - `gutenberg_sync_engines_storage()` is gone. Call
    `wp_rtc_get_storage()`.
- Only a user who may publish unfiltered HTML can approve an edit held
  for that reason, and only such a user or the edit's author can dismiss
  it. The server refuses any other decision.

### Removed

- The `POST /wp-sync/v1/save` route, which only a Yjs engine used.
- The `yjs-server` and `de-rtc` engines, with their vendored libraries
  and the de-rtc commit interval setting. A site set to either engine
  now runs intent-log.
- The `sse` and `sse-daemon` transports, with the
  `WP_SYNC_SSE_REDIS_URL` setting that was removed with them. A site
  set to either transport, or to the older long-polling transport that
  was retired before them, now runs polling.

## Earlier history

Changes made before this plugin was created are in the
[changelog of `gutenberg-sync-engines`](https://github.com/WordPress/gutenberg-sync-engines/blob/9f5267b8914db5c8a72eff19aa9c75c7b8d63bf5/CHANGELOG.md).
