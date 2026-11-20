# Transport experience benchmark

Measures what a **transport** choice does to the collaboration experience and
to the hosting bill, using two real browser clients against a live site. It
complements the engine benchmark one directory up: that harness times the
server engine seam in-process; this one measures the end-to-end path the
engine harness deliberately excludes — polling cadence, request volume, and
edit-to-visible latency as a user experiences it.

## What it measures

- **Edit-to-visible latency** — window A inserts a unique token; both windows
  stamp `Date.now()` *inside the page* (a `wp.data.subscribe` watcher) when
  the token appears in their block store. Latency is B's arrival stamp minus
  A's local-echo stamp: same machine, same clock, no automation IPC skew.
  Trials are spaced with deterministic jitter so arrivals sample the polling
  phase instead of locking to it. Reported as min/p50/p90/max/mean over the
  measured trials.
- **Wire traffic per collaborator** — every `/wp-rtc/v1/` request (count,
  request/response body bytes) or WebSocket frame per window, during two
  phases: *editing* (the trial loop) and *idle* (both windows open, nobody
  typing). The idle phase is the steady-state carrying cost per collaborator
  that hosts should size for. Byte counts are message bodies only; HTTP
  headers add roughly another 0.5–1 KB per request on top.
- **Observed transport** — advisory WebSocket frames count toward traffic
  but do not establish a WebSocket content transport. Content `sync` frames
  are required. The transport is self-labeled from the traffic actually seen
  (websocket frames / `/updates`), and compared against the
  requested transport. A mismatch usually means a
  `WP_COLLABORATION_TRANSPORT` constant/env override on the site, or a
  failed negotiation.
- **Server-side per-request metrics** (community-harness conventions) —
  every `/wp-rtc/` request the windows make is tagged with the
  [WordPress/distributed-rtc-performance-testing](https://github.com/WordPress/distributed-rtc-performance-testing)
  harness's headers (`X-RTC-Test`, `X-RTC-Scenario: editing|idle`), so a
  site with this plugin's diagnostics request log (local/development
  wp-env, or the `WP_RTC_DIAGNOSTICS` constant) records
  dispatch wall/CPU time, `db_queries`, `db_time_ms` (needs
  `SAVEQUERIES`), peak memory, and concurrency per request. The benchmark
  clears that log up front and folds per-scenario aggregates into the
  summary (`serverSide`, using the community metric names), making runs
  directly comparable with community-published report tables. Without the
  diagnostics module the tags are inert and `serverSide` is null.
- **Baseline** (community convention) — before the trials, N
  unauthenticated `GET /wp/v2/types` round-trips (client-timed over a
  kept-alive connection) plus N tagged empty RTC polls
  (`scenario=baseline`, `approach=baseline`). The server-side report
  normalizes every scenario against the baseline scenario's mean, which is
  how community tables compare environments.

## Running it

Needs a running environment with the Gutenberg subtree and this plugin
active (see the repo README), and `npx playwright install chromium` done
once. Then, from the repo root:

```bash
node tests/benchmarks/transport/benchmark-transport.mjs \
    transport=http-polling trials=30 json=polling.json

# Needs the sync daemon. See "The websocket transport" below.
node tests/benchmarks/transport/benchmark-transport.mjs \
    transport=websocket trials=30 json=websocket.json
```

Arguments are bare `key=value` tokens (the engine benchmark's convention):

| Argument     | Default   | Meaning                                             |
| ------------ | --------- | --------------------------------------------------- |
| `transport=` | `current` | Transport to measure; switched via the Settings →   |
|              |           | Collaboration screen and restored afterwards.       |
| `engine=`    | `current` | Engine to measure under (`intent-log`). |
| `cache=`     | `current` | Persistent object cache for the run: `none`, `redis` (the Redis Object Cache drop-in on the env's Redis; this checkout's wp-env sites only), or leave alone. Restored after. |
| `trials=`    | `30`      | Measured token round-trips.                         |
| `warmup=`    | `3`       | Unmeasured leading trials.                          |
| `idle=`      | `30`      | Idle-phase seconds (`0` skips the phase).           |
| `baseline=`  | `10`      | Ambient-overhead samples (`0` skips the phase).     |
| `json=`      | —         | Write full results (per-trial data included) here.  |
| `headed=1`   | —         | Visible browser, for debugging.                     |

Add `recovery=1` (`--recovery` through `npm run bench`) to interrupt the
receiving tab's HTTP sync requests, accept an edit while it is offline, and
require it to catch up without a reload. The JSON report includes the
recovery time separately from normal edit latency.

Two caveats on the server-side lane. The scenario tagging intercepts
`/wp-rtc/` HTTP requests through Playwright routing, adding a small
per-request overhead inside the measured latency — identical across
phases, but latency comparisons against pre-tagging runs carry that delta
(single-digit ms; negligible at polling cadence). And it covers HTTP
requests only: websocket data frames bypass both the tagging and the
REST dispatch the request log measures, so under `transport=websocket`
the `serverSide` aggregates hold just the baseline polls.

Environment: `WP_BASE_URL` (default `http://localhost:8889`, the wp-env
tests site), `WP_USERNAME`/`WP_PASSWORD` (default `admin`/`password`). The
collaboration option is enabled automatically if it isn't already. Both
browser windows run on this machine — don't compare absolute numbers across
machines without noting the environment, and keep the machine otherwise idle
during a run.

### The websocket transport

The websocket transport needs the sync-server daemon running on an address
the *browser* can reach. For the DEV site, `npm run rtc:ws` is the
one-command start (it selects the websocket transport and runs the daemon
with its port published), and the dev env's afterStart hook keeps a daemon
running anyway. This benchmark targets the TESTS env
(`.wp-env.tests.json`, its own wp-env project), where the same two pieces
apply manually:

1. The config sets `WP_RTC_WEBSOCKET_HOST` to `localhost` (already in this
   repo's config) so the announced socket URL shares the site's cookie
   domain — the daemon authenticates the browser's `logged_in` cookie, and
   cookies for `localhost:<port>` are not sent to the default `127.0.0.1`.
2. wp-env cannot publish extra container ports itself, but its generated
   compose file can. Start the daemon with the port published AND bound to
   `0.0.0.0` (a loopback-bound daemon is unreachable even through a
   published port). The tests env's work dir carries a `-tests-` segment
   and its single environment's WP-CLI service is `cli`:

   ```bash
   docker compose \
       -f "$(ls -d ~/.wp-env/wp-env-*$(basename "$PWD")*-tests-*)/docker-compose.yml" \
       run --rm -p 8787:8787 cli \
       wp collaboration sync-server --host=0.0.0.0 --port=8787
   ```

   (Stop the dev env's auto-started daemon first if it holds port 8787:
   `docker rm -f wp-rtc-ws-daemon`. `curl localhost:8787/health` from the
   HOST should answer `OK` — if it doesn't, the browser can't connect
   either and clients retry silently with no visible error.)

The benchmark then works with `transport=websocket`: it counts WebSocket
frames/bytes instead of HTTP requests, and fails with a clear message when
the daemon is unreachable (window B never receives the anchor paragraph).

To measure the DEV site instead, run `npm run rtc:ws` and point the
benchmark at that site:

```bash
WP_BASE_URL=http://localhost:8888 node tests/benchmarks/transport/benchmark-transport.mjs \
    transport=websocket trials=30 json=websocket.json
```

## Reading the numbers

- **http-polling**: latency has *two* polling legs — the edit waits in A's
  queue until A's next poll sends it, then B receives it on B's next poll —
  so expect a p50 around one full polling interval (5 s by default; the
  e2e setup pins the tests site to 1 s) and a max near two. Requests continue at the same
  cadence while idle; that idle request rate × collaborators is the host's
  steady-state load.
- **websocket**: true push — observed p50 ≈ 30 ms edit-to-visible (~60×
  better than polling) with the lowest idle
  wire volume by far (~14 frames/idle-30 s per window vs ~28–49 HTTP
  requests). The price is the heaviest hosting ask: a persistent daemon,
  TLS termination, and an exposed port.

Latency includes the engine's client-side apply path. Use the engine
benchmark for the engine's server cost.

## The N-window soak

The hour-scale multi-window validation run is a debugging and analysis
tool, not a benchmark: it lives at `tests/debugging/soak-transport.mjs`
with its documentation in `tests/debugging/README.md`. It imports this
directory's `lib.mjs`, so the soak and this benchmark use identical
counters, tagging, and server-log collection.
