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

- This plugin was created from `gutenberg-sync-engines` at commit
  `9f5267b8914db5c8a72eff19aa9c75c7b8d63bf5`. It keeps the intent-log
  engine, the polling and WebSocket transports, the advisory channel,
  and the conflict review screens.

### Removed

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
