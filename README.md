# WP Real-Time Collaboration

An exploratory WordPress plugin for trying out **server-aware** real-time
collaboration in Gutenberg. It provides one sync **engine**, intent-log
(how the server merges edits from several people), and two
**transports** (how updates move between the editor and WordPress). The
transport is selected from a settings screen.

**This plugin is experimental.** Real-time
collaboration was removed from WordPress 7.0, and the concerns behind
that decision call for a change in direction: collaboration should run
through WordPress, with Core in control. The reasoning is explored in
[Moving to a server-aware approach for collaboration](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/).

## Where this plugin came from

This plugin was created from the `gutenberg-sync-engines` plugin at
commit `9f5267b8914db5c8a72eff19aa9c75c7b8d63bf5`. It replaces that
plugin for intent-log work. The other engines and the server-sent
events transports stayed behind.

- **The two plugins cannot be active on one site at the same time.**
  They declare the same PHP functions, so activating the second one is
  a fatal error. Deactivate `gutenberg-sync-engines` first.
- **A site that ran the old plugin with another engine keeps its old
  rooms.** A room is one post's shared editing session, and it remembers
  the engine that first wrote it. Such a room refuses an intent-log tab
  with an HTTP 409.

## Requirements

WordPress 7.0 and the
[Presence API](https://wordpress.org/plugins/presence-api/) plugin, which
must be active before this plugin can be activated. The wp-env
environments and both Playground blueprints install it.

## Install and try it

1. Install and activate the Presence API.
2. Install the plugin zip and activate it. Build the zip with
   `npm run plugin-zip`, or take one from the
   [releases page](https://github.com/Automattic/wp-real-time-collaboration/releases/latest).
   Activation creates the storage tables and switches real-time
   collaboration on.
3. Open the same post in two browsers as two users and type. Changes
   appear in the other window within seconds, each window shows the
   other person's avatar, and when both change the same paragraph at
   once a review panel offers to restore or dismiss the change that was
   set aside.

The defaults need nothing from the host: the intent-log engine, and
the WebSocket transport with polling as its backup. Until a sync daemon
address is set, tabs poll, with a WebRTC advisory channel. Every option is explained on the
settings screen itself. Deactivating the plugin turns
collaboration off and keeps the storage tables; deleting it drops them.

## What it provides

### The engine

#### intent-log

The editor sends short descriptions of what changed, such as "move this block". The server keeps an ordered log of these and works out how to combine edits that overlap. Genuine conflicts are set aside for someone to review, so no work is silently lost.

https://github.com/user-attachments/assets/3c05f1c4-27ec-4a28-ba75-ce256b20864a

When two people edit at the same time, the server adjusts the later edit around the earlier one before adding it to the log, so both are adjusted for what each person meant:

https://github.com/user-attachments/assets/3563cba8-0537-4aa1-8794-9c712439b3a4

### Transports

- **http-polling**: the editor asks the server for updates on a short
  timer. Every host can run it (default). Beside it, an **advisory
  channel** links the browser tabs on one post. It tells each tab who
  else is here and when to fetch new changes, and it never carries
  content, so a tab polls only when there is something to fetch. It runs
  over WebRTC between browsers or over a WebSocket.
- **websocket**: the server pushes updates over a persistent connection
  served by a bundled PHP daemon (`wp collaboration sync-server`). A tab
  that cannot reach the daemon uses polling instead.

[docs/transports.md](docs/transports.md) compares them and says what
each needs from a host.

### Storage

Each post's shared editing session (a room) lives in two plugin-owned
tables instead of post meta, so no collaboration write touches post
caches. Who is present
lives in the Presence API's table. Deactivating the plugin keeps the
tables and every session; deleting it drops them. See
[docs/storage.md](docs/storage.md).

## Architecture

The plugin owns the whole server side: the engine and transport
contracts and registries, room names and permissions, the REST routes,
and the settings printed for the browser (`includes/server/`). Its
engine and transports register through the `wp_rtc_engines` and
`wp_rtc_transports` PHP filters, so other code can add its own.

The plugin touches Gutenberg in three places. In PHP it answers the
`wp_is_collaboration_enabled` filter, which switches collaboration on.
In the browser it registers one sync provider with core-data, which then
hands it every local edit as a list of operations and takes remote
changes back. The plugin keeps its own registries for engines and
transports in front of that one registration. The server says which
engine and transport to use, and the browser checks that it has them.
If they do not match, the editor uses the classic post lock instead, so
nothing is corrupted.

How an edit travels is in [docs/data-flow.md](docs/data-flow.md). How to
add an engine or a transport is in [docs/protocol.md](docs/protocol.md).
Every page is indexed in [docs/README.md](docs/README.md).

## Measuring the cost

Moving merge work to the server has a cost, and this repository
measures it. `npm run bench` reports what the plugin
adds to a server on your own hardware, and
`npm run bench -- --suite=engines` runs the engine checks for
intent-log. The
benchmarks, the fuzzer, and the debugging tools are described in
[tests/benchmarks/README.md](tests/benchmarks/README.md),
[tests/fuzzer/README.md](tests/fuzzer/README.md), and
[tests/debugging/README.md](tests/debugging/README.md).

## Development

The plugin needs a Gutenberg that lets a plugin supply the sync
provider. That work is on a Gutenberg branch, and a copy of it is in
`gutenberg/`. `gutenberg-pin.json` names the exact commit. The plugin
loads this bundled copy when no standalone Gutenberg plugin is active.

```bash
composer install          # PHP tooling
npm install               # Plugin dependencies
cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
npm run build             # Plugin client bundle
npm run env start         # Start WordPress at http://localhost:8888
npm run env:stop          # Stop it (and the Redis container)
npm run test:js           # Jest
npm run test:php          # PHPUnit in the wp-env tests container
npm run test:e2e          # Playwright, two-browser collaboration
```

`npm run playground` serves the built checkout on a local WordPress
Playground instead. `AGENTS.md` is the full guide to working in the
repo: environments, the test ladder, diagnostics, and the traps.
To type in a second window by yourself, see
[tests/tools/README.md](tests/tools/README.md).

## Maintainers

This plugin is maintained by the WordPress Core team, with contributions from
the community. The maintainers are:

- Chris Zarate ([@chriszarate](https://github.com/chriszarate))
- Alec Geatches ([@alecgeatches](https://github.com/alecgeatches))
- Joe Fusco ([@josephfusco](https://github.com/josephfusco))

## Feedback

Open GitHub issues or discuss in `#feature-realtime-collaboration` channel in
[WordPress Slack](https://make.wordpress.org/chat/). To contribute, see
[CONTRIBUTING.md](CONTRIBUTING.md).
