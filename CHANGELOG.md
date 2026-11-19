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
- The intent-log protocol is version 3. Each stored edit carries the
  room's position after it (`seq`), a request must name its protocol
  version, and each row of a request gets its own answer. A browser tab
  loaded before the update is refused and falls back to the post lock
  until it is reloaded. A room that still holds edits from an older
  version is reset to the saved post when it is first opened, so edits
  in it that were never saved are lost.
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
