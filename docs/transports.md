# Transports

A transport is how updates move between the editor and WordPress. The
engine is a separate choice: intent-log runs over either transport. Both
transports carry the same request (the room envelope in
[protocol.md](protocol.md)); they differ in who holds a connection open
and what that costs the host. Run `npm run bench -- --suite=transport`
for measured latency and idle traffic on your hardware.

| Transport | Edit-to-visible | Idle cost per collaborator | Needs from the host |
| --- | --- | --- | --- |
| `http-polling` | seconds, bounded by the poll interval; under a second when the advisory channel is up | one request per interval, or none while nothing changes | nothing |
| `websocket` (default) | tens of milliseconds | a few frames per heartbeat, plus the daemon | the daemon, and a proxy that passes the WebSocket upgrade |

WebSocket is the default, with polling as its backup. A tab polls until
its socket opens and whenever the socket is down, and takes the room
back onto the socket when it opens again. A site that has not said
where its daemon is (the "WebSocket transport server" setting is empty,
neither `WP_SYNC_WEBSOCKET_HOST` nor `WP_SYNC_WEBSOCKET_PORT` is
defined, and nothing answers the `wp_sync_websocket_url` filter) is
taken to have no daemon: its tabs never ask for a socket token and
poll, with the WebRTC advisory channel. So the default needs nothing
from the host until a daemon is set up.

A post admits <!-- const:DEFAULT_CLIENT_LIMIT_PER_ROOM -->5<!-- /const --> editor
tabs by default, including the joining tab, checked on a tab's first
connection (`sync.pollingProvider.maxClientsPerRoom`). The websocket
transport falls back to polling when its connection fails, and comes
back when it can. Every setting is explained on the Settings → Collaboration screen
itself. The options are plain WordPress options, so WP-CLI and the REST
settings endpoint can set them: the on/off switch is `wp_rtc_enabled`,
the engine is `wp_sync_engine`, the
transport `gutenberg_sync_engines_transport`, the advisory channel
`gutenberg_sync_engines_advisory_channel`, and the rest start with
`gutenberg_sync_engines_`. `WP_COLLABORATION_TRANSPORT` (constant or
environment variable) takes priority over the stored transport choice,
and the `wp_sync_websocket_url` filter over the daemon address.

## Polling and the advisory channel

Short polling is the transport every host can run: the editor sends
`POST /wp-sync/v1/updates` on a timer with every open room's queued
edits and gets back the rows it has not seen. Beside it, every editor
tab opens an **advisory channel** to the other tabs on its post. The
channel carries presence (who is here) and the sentence "I landed rows,
go and poll", never content. It runs over one of two links, chosen on
the settings screen: WebRTC between the browsers (`webrtc-advisory`, the
default, with the handshake relayed through the WordPress heartbeat and
the polls), or one WebSocket per tab to the sync daemon or to a relay
the host runs (`websocket-advisory`, which reaches tabs WebRTC cannot).

The channel decides how often a tab polls:

1. **When you are alone, the tab stops polling**, except for 30
   seconds after the page loads or regains focus. Its edits stay in the
   browser until someone else arrives, until a save (the edits go
   through the room first), or until the tab is hidden. A reload loses
   them, which is what the editor's own unsaved-changes warning says.
   The heartbeat's answer names the room's
   newest row, so a script or WP-CLI saving the post still wakes the
   tab.
2. **When a peer cannot be reached, the tab polls on a timer**: the
   "Polling interval" setting, <!-- const:POLLING_INTERVAL_DEFAULT -->5<!-- /const --> seconds
   by default.
3. **When every peer can be reached, the tab polls only when needed**:
   when it has edits to send, when a peer says it stored new rows, or
   when the heartbeat reports rows it has not seen. No timer.
4. **The channel is a hint only.** It never changes what a tab shows.
   The server's presence records say who is in the post; the channel
   only shows presence faster.
5. **The channel runs only while a tab is polling.** The websocket
   transport carries everything itself while its socket is open. The
   channel starts when the socket is down and polling takes over.

If the channel fails (it never connects, a peer drops off it, or more
than <!-- const:DEFAULT_MAX_PEERS -->8<!-- /const --> tabs are on one post), the tab polls on its timer as if
there were no channel. Nothing is lost. A hidden tab polls every 25
seconds. The relay a host can run in place of the daemon is in
`examples/advisory-relay/README.md`.

## WebSocket

The websocket transport moves everything over one socket per tab to the
sync daemon (`wp collaboration sync-server`), authenticated with a
one-time token offered in the `Sec-WebSocket-Protocol` header rather
than the URL, so it stays out of access logs. Whenever the socket is
down (token refused, daemon unreachable, dropped, or not open within
five seconds) polling carries on from the last row the socket
delivered, and the socket takes over again from the last row polling
delivered when it reopens. Only one of them serves a room at a time, so
no row repeats. Plain `ws://` must never leave a dev box;
the `wss://` address behind TLS goes in the "WebSocket transport server"
setting.

## When the last editor leaves

What happens to unsaved changes when the last editor leaves a post is
the "Unsaved changes" setting. By default they are discarded: every tab
tells the server when it leaves (a beacon on `pagehide`, or the socket
closing), and a per-post room nobody is in is reset to the saved post,
at once on the last leave or when a new tab arrives and finds nobody
there. Every room response carries a generation token (the id of the
room's first row), so a tab whose room was reset under it starts over
from the saved post. The alternative, `keep`, lets the room live on as
a shared working copy. Engines that keep data elsewhere clear it on the
`gutenberg_sync_engines_room_reset` action. Rooms not tied to one post
(a taxonomy's list) are never reset this way.

## Presence on a slow connection

Live cursors only work when every editor holds the same document and
updates arrive before the other person moves on. Over polling every few
seconds they always show a spot someone has left. Intent-log
has no shared document to place them in at all. The "Awareness
interval" setting replaces cursors with block presence: once per
interval each editor names the block its selection is in (`gseBlock`),
sent only when it changes, and other editors see Gutenberg's block
outline and an avatar badge on that block. The name travels with
whatever already carries presence (the sync transport by default, or
the WordPress Heartbeat when "Awareness channel" says so, which then
needs an advisory channel selected). A name for a block the receiver
does not hold yet shows nothing until the block arrives.

## What a host must provide

- **Polling:** nothing. The WebRTC link needs the browsers to reach a
  STUN server (a public Google one by default;
  `gutenberg_sync_engines_advisory_ice_servers` replaces the list) and
  falls back to the timer when they cannot.
- **The sync daemon** (the `websocket` transport, and the
  `websocket-advisory` channel unless a relay serves it): a PHP command-line
  process that never ends, on port 8787 by default, answering
  `GET /health`. Keep it out of the web worker pool. Start it with a
  process manager that restarts it, put the web server in front of it
  for TLS and pass one path to its local port (unbuffered, reads longer
  than its <!-- const:IDLE_TIMEOUT_S -->45<!-- /const -->-second idle timeout, WebSocket upgrade headers passed).
  It needs only the database (and the object cache, if any): web
  requests and the daemon share the room tables and never talk to each
  other. Restart it now and then; tabs reconnect from the last row they
  received. Run one daemon per site. Limits: <!-- const:DEFAULT_MAX_CONNECTIONS -->512<!-- /const --> connections,
  <!-- const:DEFAULT_MAX_CONNECTIONS_PER_IP -->20<!-- /const --> per IP,
  <!-- const:MESSAGE_RATE_LIMIT -->200<!-- /const --> messages per socket per five seconds. A host that cannot run its
  own processes should use polling.

Upgrading, deactivating and uninstalling the plugin are described in
[storage.md](storage.md); switching engines mid-session in
[protocol.md](protocol.md).
