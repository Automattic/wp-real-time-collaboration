# The wire protocol

Every transport sends the same request, the room envelope. The client
names a room (one post's shared editing session), the last row it saw,
and any updates to store. The server answers with the newer rows, a
verdict on each update, and who is present. The transport moves
`{ type, data }` updates without reading them; the active engine gives
them meaning. The intent-log vocabulary itself is in
[`src/engines/intent-log/SPEC.md`](../src/engines/intent-log/SPEC.md).

## Routes

| Route | Purpose |
| --- | --- |
| `POST /wp-sync/v1/updates` | Polling: one request carries every open room. |
| `POST /wp-sync/v1/ws-token` | Mints the daemon credential: a one-time token, or a signed access token when a secret is configured. Answer `{ token, expires_in }`. |
| `POST /gutenberg-sync-engines/v1/advisory/leave` | The leave beacon a tab sends on `pagehide`, so its presence goes at once. |
| `rtc-test/v1/*` | The per-request benchmark log, dev-only (`GUTENBERG_SYNC_ENGINES_DIAGNOSTICS`). |

The sync daemon (`wp collaboration sync-server`, port 8787 by default)
serves the WebSocket (the browser offers `Sec-WebSocket-Protocol:
wp-sync, wp-sync-token.<token>`; the daemon echoes `wp-sync`) and
`GET /health`. It answers 400 to any other request that does not ask
to upgrade to a WebSocket.

## The room envelope

One request carries up to 50 rooms in at most 16 MB (the client packs
to 15 MB and shrinks to a 2 MB floor on "too large"); one encoded update
is at most 1 MB. Shapes: `src/providers/http-polling/types.ts`.

```json
{ "rooms": [ { "room": "postType/post:123", "client_id": 12345, "after": 987654,
               "engine": "intent-log", "engine_protocol": 2, "awareness": {},
               "updates": [ { "type": "intent", "data": "…" } ],
               "presence_token": "…", "debug": false } ],
  "advisory": { "seq": 7 } }
```

```json
{ "rooms": [ { "room": "postType/post:123", "end_cursor": 987660, "generation": "987001",
               "awareness": { "12345": {} },
               "dispositions": [ { "intentId": "…", "status": "applied" } ],
               "updates": [ { "type": "intent", "data": "…" } ] } ],
  "advisory": {} }
```

| Field | Meaning |
| --- | --- |
| `after` / `end_cursor` | The id of the last row the tab saw, sent back as `after` next time (the cursor). |
| `client_id` | A number the tab picks; bound to the user who first used it. |
| `engine` / `engine_protocol` | The engine the tab speaks. If the room was written by another engine, the request is refused with **409 `rest_sync_engine_mismatch`** before anything is stored, and the editor falls back to the post lock. |
| | Shared rooms not tied to one post (a taxonomy's list) are reset instead when a tab speaking the newly chosen engine arrives. |
| `awareness` | This tab's presence state in; every live tab's state out. Entries expire 30 seconds after their last write. |
| `updates` | Engine-owned rows in; stored rows after the cursor out. |
| `dispositions` | The result of each sent update, `{ intentId, status, reason? }`, one per update in the order sent: `applied`, `escalated` (held for review), `voided` (thrown away) or `unknown`. |
| | An update the server could read no id from is named by its place in the request, counted from 0: `{ row, status, reason }`. |
| | An update the engine cannot use is refused by itself (`voided`). The other updates in the request are still handled, and the request gets a 200. |
| | Reasons are engine-defined, for example `frame-conflict`, `stale-base`, `invalid-payload` (a malformed update), `invalid-type` (a row type only the server writes). |
| `generation` | The id of the room's first row; it changes on every reset, and a tab that sees a new value starts again from the beginning. |
| `presence_token` | The tab's per-tab token, sent on the post's own room; the first request carrying it is the tab's join. |
| `advisory` | The advisory channel's discovery probe, answered beside the rooms. |
| `debug` / `_debug` | Asks for the engine's diagnostics, served when the `wp_sync_debug_enabled` filter allows (default `SCRIPT_DEBUG`). |

Other statuses: 403 `rest_cannot_edit`, 413 when a body or a room is
too large, 503
when the intent-log room lock could not be
taken in time, which the client retries.

Over the socket the same envelope travels as `{ "type": "sync", "rooms": [ … ] }`
frames both ways, plus `type: "advisory"` frames on the advisory link
and `type: "error"` frames when the daemon refuses something.

## Row types

Every stored row is `{ type, data }`. A client may send only the types
marked "client".

| Engine | Type | Sent by | Holds |
| --- | --- | --- | --- |
| intent-log (protocol 2) | `intent` | client | One typed edit, stored after the server transformed it against newer rows. |
| | `snapshot` | server | A full copy of the document: the first version and later checkpoints. |
| | `parked` | server | An edit held for review. |
| | `voided` | server | A marker that an edit was thrown away. |
| | `resolved` | client | A reviewer's decision on a parked edit. |
| | `cancel` | client, never stored | Cancels edits the server has not accepted yet; all or nothing. |

A script or plugin that saves a post needs none of this. If it names
the version it read (`base_seq`), the server merges its save with other
people's edits.

## Who may do what

Every route needs a logged-in user with `edit_posts`, and for each room
the plugin checks that the user may edit that entity (403 and the
list of refused rooms otherwise). A tab's `client_id` and presence token
are bound to the user who first used them. The engine checks each
edit on the server before anyone else sees it. Markup the author may
not publish (what `wp_kses_post` would change, for a user without
`unfiltered_html`) is held for review.

| Credential | Used for | Lives |
| --- | --- | --- |
| Cookie + REST nonce | the REST routes | the WordPress session |
| One-time token | the daemon's socket, in a header, never the URL; the daemon also requires the `logged_in` cookie and checks `Origin` against the site's own | two minutes, spent on first use |
| Access token (when `WP_SYNC_WEBSOCKET_ACCESS_TOKEN_SECRET` is set) | the daemon and a host's own relay: a JWT signed with the shared secret, claims `user_id`, `blog_id`, `iss`, `rooms`, `iat`, `exp` | two minutes; anyone with the secret can mint one |
| Presence token | finding the other tabs on a post | five minutes after the last heartbeat |

The daemon runs WordPress code and writes the room tables, so it is
trusted like a web worker and must sit behind TLS. A relay sees only
who is present and "go and poll" notices; the worst a bad one can do is
cause extra polls or show false presence.

## Adding an engine or a transport

An engine is two pieces, registered through one filter on each side:

- A PHP class implementing `WP_Sync_Engine`
  (`includes/server/interface-wp-sync-engine.php`):
  `get_slug`, `get_protocol_version`, `get_update_types`,
  `handle_updates`, `get_updates_since`. Register it on the
  `wp_sync_engines` filter.
- A JavaScript engine registration (`src/registry/engines.ts`): a
  slug, a protocol version, and `createProvider`, which returns the
  object core-data calls for loads, edits, saves and undo (its shape is
  in `src/editor/gutenberg-contract.ts`). Register it with
  `registerSyncEngine`, as `src/index.ts` does, or through the
  `sync.engines` filter.
- Give a new room its starting field values from
  `WP_Sync_Post_Genesis_Props`, and register a benchmark profile on
  `wp_sync_bench_authoring_profiles` (`tests/benchmarks/README.md`).

A transport is a `WP_Sync_Transport` (`get_slug`,
`get_protocol_version`, `register_routes`) on the `wp_sync_transports`
filter, plus a provider factory registered with
`registerSyncTransport`. The websocket transport
(`includes/transports/websocket/class-wp-websocket-sync-transport.php`
and `src/providers/websocket/websocket-provider.ts`) is the model.
Every filter and action the plugin offers:
`grep -rn "apply_filters\|do_action" includes`.
