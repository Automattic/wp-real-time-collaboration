# Benchmarks

The host report includes session-size measurements. Set the total peer count:

```bash
WP_BASE_URL=http://localhost:8889 npm run bench -- --peers=5 --p95-ms=2000 \
  --json=bench-results/host-5.json
```

`--peers=N` takes one positive integer (default 2). `--windows=N` remains an
alias. Each peer writes its own paragraph. Each has a separate browser
connection pool, so large runs do not share one browser's HTTP connection
limit. All browsers run on one machine and share its clock and CPU. The benchmark overrides the normal five-peer join limit only in its
own browsers; the site's limit stays unchanged.

The same run reports server costs and edit delivery times (p50, p95, p99).
Delivery time starts at the browser's input event and ends when the marker
first appears in another editor's data. It includes time spent waiting to
send, server work, and remote processing; it does not measure screen paint.
Each edit-to-other-peer pair is one sample. Missing or invalid samples are
counted separately and always fail the run. One peer has no remote delivery
samples, so its delay columns show a dash.

`--p95-ms=2000` fails the run when p95 exceeds two seconds. Without this
option, delays are reported without a pass limit. `--max-lag-ms=1000` sets
the largest allowed delay in issuing a scheduled input (default one second).
A slow test browser must not make an overloaded run appear successful by
typing less often. The report also checks the complete final document and
counts missing markers, duplicates, and edits that appeared then vanished.
A content failure during collaboration suppresses the cost comparison and saves the delivery
evidence to `--json`, when supplied. A delivery or typing-delay failure
retains the cost report and exits with a nonzero status.

To compare sizes and repeat runs, run the same command for each count:

```bash
for peers in 2 4 5 8 16; do
  for repeat in 1 2 3; do
    WP_BASE_URL=http://localhost:8889 npm run bench -- --peers="$peers" \
      --p95-ms=2000 --json="bench-results/host-${peers}-${repeat}.json"
  done
done
```

Each run includes a serial baseline, so larger counts take longer. Keep the
engine, transport, durations, polling setting, and host unchanged when
comparing results. The initial document has one paragraph per peer, so its
size also grows with the count. These measurements do not establish a
production capacity guarantee. The JSON records advisory-channel state
before and after editing; an exceeded WebRTC peer limit causes timer-based
polling and is also noted in the printed report.

One command runs everything here:

```bash
npm run bench
```

By default that prints **the host cost report** — the small set of numbers
someone hosting this plugin actually needs, each measured as the difference
against the workflow the plugin replaces:

- extra requests per minute, per person editing (and per idle open tab);
- HTTP body and WebSocket payload traffic (KiB/min), excluding
  headers, protocol overhead, compression effects, and WebRTC traffic;
- extra PHP CPU time per minute (not database, Redis, or relay CPU);
- the extra share of one PHP worker held;
- peak PHP memory per request;
- options-cache invalidations per minute (every options-API write
  invalidates the shared options cache on hosts running a persistent
  object cache — the plugin's lock and counter primitives deliberately
  bypass that API, and this row proves it);
- database queries per minute — every query the tagged requests ran,
  from mu-plugin load onward, per person;
- database fsyncs per minute — how often the database forces data to
  disk, sampled from the database server's own InnoDB counters at span
  boundaries. Every commit writes its change to the redo log and
  fsyncs it, so this follows write transactions closely. Group commit
  and database settings affect how transactions share that work — hold
  fsyncs/min against the host's storage telemetry, not as a direct
  device IOPS count. The counters are server-global, so the row is
  trustworthy only when the run is the database's only traffic. The
  report has no data-file read or write rows: commits reach disk
  through the redo log, table pages flush lazily in large background
  batches, and a small site's tables stay in memory, so those counters
  read 0 over any span this benchmark measures. True device-level IOPS
  sits below what any WordPress
  request can see and remains the host's own telemetry. Log
  rows also carry the PHP process's own block I/O
  (`php_io_reads`/`php_io_writes`) — ~0 with a warm opcache, which is
  exactly the column that spikes in the cold-opcache-after-deploy
  scenario;
- logical row storage held per collaborative post at rest, and a derived
  editors-per-worker capacity estimate (whole-job totals for producing
  the same final document land in the `json=` report as `engine.job`).

The workload model follows the lowest-common-denominator assumptions the
plugin itself makes: HTTP short-polling is the default transport because it
works everywhere, every request is an authenticated POST (nothing is HTTP-
cacheable), no object cache is assumed, and the load scales per editor.
Nothing here depends on wp-cron: history is bounded on the write path, so a
quiet site with a cron that never fires holds exactly what the logical room-
storage line reports. This is row payload size, not allocated disk space
including indexes and database overhead.

Reading the report: the editing and idle tables start after editor setup, so
they exclude initial page-load and session-join costs. Tagged setup requests
remain in the raw log. CPU and query measurements start when the measurement
mu-plugin loads; earlier WordPress bootstrap work is excluded. HTTP requests
and WebSocket frames have separate rows. Socket payload bytes include
advisory messages, but only content-sync frames establish that the content
transport is WebSocket.

The host suite finds this checkout’s running wp-env test site automatically.
`WP_BASE_URL` overrides that choice for another site. The runner prints the
target URL and checks measurement support before login or site changes. If
the test site is stopped, run `npm run env:tests start`. It never falls back
to a shared localhost port.

Server measurements use request timelines. Each tagged PHP request
gets an ID, cumulative CPU and query samples, and a final shutdown record.
Sampling makes no database calls. Timelines
are kept in memory and written with the existing shutdown log row.

**Ranges describe measurement uncertainty, not statistical confidence.**
Occupied PHP worker time is the overlap between each request's lifetime and
the measurement period. CPU and query work entirely inside a period is
counted exactly. Work between two samples that straddle a boundary is
included only in the upper bound. It is never divided in proportion to time:
a 40 ms CPU burst across a boundary contributes 0–40 ms, not an assumed 20 ms.
Clock-calibration uncertainty also widens the bounds. Difference columns use
the full bounds of both runs; percentage changes are omitted for ranges.

The runner calibrates the PHP clock before and after each session using a
probe that works with the plugin deactivated. It bounds the clock offset by
the probe's send and receive times; it does not assume equal network delays.
The same server must handle the probes and measured requests. Requests with
clock jumps, counters that move backwards, missing shutdown records, or
samples that disagree with whole-request totals make server results
unavailable. After closing the editor windows, collection waits up to 20
seconds for shutdown records. A killed worker that cannot log
its final counters does not silently count as zero cost.

These samples still have a cost: CPU includes sampling overhead, and PHP
memory includes the bounded sample buffer (at most 4,096 checkpoints plus
the final sample per request). A capped trace keeps its final counters and
produces wider bounds for its remaining duration. The memory row is the
peak of requests that overlap the period, not a per-period allocation.
CPU and query capture stops before log preparation and insertion; worker
time stops at the logger's shutdown callback. The whole-request rows and
samples remain in the JSON for independent inspection.

WebSocket processes run outside the request logger. To measure the supplied
PHP daemon or the example Node advisory relay, start each selected process
with `WP_RTC_BENCH_METRICS=1`. This explicitly enables a read-only
`GET /bench-metrics` endpoint on its existing listening port. Leave the flag
off for normal use; the endpoint has no authentication, so enable it only
on an isolated benchmark server or behind access controls.

Pass every process you want to inspect to the host runner, for example:

```sh
npm run bench -- --transport=websocket --websocket-metrics=http://localhost:8787/bench-metrics --json=/tmp/websocket-costs.json
```

Use a comma-separated list when a separate advisory relay also runs. The
runner checks all listed endpoints before site changes. It records process
CPU milliseconds and database query counts between samples, plus memory at
both sample boundaries. PHP reports allocated PHP memory; Node reports
resident process memory (RSS). These are different measures and are not
added together. Neither memory value is a peak. The example relay makes no
database calls and reports zero queries.

These are **whole-process measurements**. Their sample periods bracket the
editing and idle periods and include probe overhead and any unrelated
clients. The daemon remains running during the baseline. Results are not
divided by editor count or added to PHP request costs. An open socket is not
an occupied PHP web worker. Missing samples, a restarted process, or counters
that move backwards make that process result unavailable. Raw samples and
separate results are retained in each session's `socketProcesses` JSON field.

Selecting an endpoint does not prove that it serves the measured browsers,
or that it covers every worker behind a load balancer. Thus **combined server
totals remain unavailable** when sockets are used. Use dedicated processes
for comparisons. Other relays need an equivalent measurement endpoint; the
PHP daemon and example relay show the version 1 response format. Database I/O counters remain separate
server-global measurements and include the logger's own writes. Use an
isolated database and keep the same measurement setup in both phases.

The JSON report (`schemaVersion: 3`) stores server rates and job CPU totals
as `{ min, max }` bounds. Per-period `serverTotals` and `baseServerTotals`
retain CPU milliseconds, occupied worker milliseconds, queries, and option
writes before rate conversion. `measurement.timeline` records clock bounds,
request/sample counts, and capped traces; `serverRows` holds the original
request timelines. Content checks, coverage limits, and configuration are
also retained. Compare runs only across identical environments. The report
measures one engine per run (`engine=`).

The `session` object contains delivery distributions, final-content checks,
per-editor input and arrival timestamps, and the pass/fail reasons.

Fleet planning must use measured rates for the current configuration. The
advisory channel can stop scheduled polling when an editor is alone and
trigger reads on demand when peers are reachable. A missing peer link uses
the configured polling interval instead. The site default is 5 seconds; the
e2e test setup sets 1 second. Do not project daily traffic from the old
fixed 4-second solo / 1-second collaborative cadence.

Run `--peers=1` to measure solo editing and idle cost, then measure several
collaborators. Record the delivery choice and configured polling setting from
the JSON report. Multiply each scenario's measured rate by the time and
open-tab count for that scenario across your platform. The host runner does
not yet provide a separate background-tab workload.

It runs two real-browser phases against a live site (the tests env: `npm run
env:tests start`). The **baseline** is the same number of people producing
the same document the old way — editing in series with the plugin
deactivated: each person completes a fixed typing script, saves, and hands
off (the post lock forces exactly this turn-taking today). Then the **sync**
phase: the plugin active and the same `--peers=` people collaborating live
on the chosen engine, typing the same scripts — so both phases must finish
with the same paragraph text. The script is built before typing: a slower
browser takes longer rather than producing fewer edits. Before each save,
every open editor must contain the expected text; a REST read then verifies
the saved post. Missing, duplicate, reordered, or extra text, typing errors,
and failed saves abort the run without a cost report. Engine-specific block
metadata is excluded from this text check. The measured editing duration
includes catch-up and save verification. The RESULTS section prints two
markdown tables (editing, then idle), columns baseline/sync/delta/delta-%,
followed by the summary stats (room storage, derived capacity). The run
opens by stating the configuration it resolved (engine, transport,
durations, polling), marking defaults. Arguments target what you need:
`--engine=` (one per run),
`--transport=`, `--peers=`, `--edit-seconds=`/`--idle-seconds=`,
`--polling-interval=` to override the HTTP short-polling interval for the
run (restored afterwards), `--metrics=` to print only some rows, `--json=`
for the full data — `npm run bench -- --help` prints the complete list. The
server-side columns come from the whole-request measurement mu-plugin
(`tests/benchmarks/host/mu-bench-log.php`, mapped into mu-plugins by this
repo's wp-env configs), which measures every tagged request even with the
plugin deactivated; that is what makes CPU, worker, and memory true over-
baseline deltas. One trap: it is a single-FILE mount, and Docker file mounts
go stale when git deletes or recreates the file (checking out an older
commit, rebasing) — if the report says the mu-plugin recorded nothing,
restart the env.

Local wp-env results describe that environment only. Point `WP_BASE_URL`
(with `WP_USERNAME`/`WP_PASSWORD`) at a staging copy of the real hosting,
install the mu-plugin, and define `WP_RTC_DIAGNOSTICS` to
measure that environment. The baseline temporarily deactivates the plugin;
use a disposable site or staging copy.

The editors-per-worker line is an estimate from measured request duration.
It assumes no queueing and reserves no spare capacity.
`npm run bench -- --suite=engines --concurrency=N` measures engine and
database contention through parallel CLI processes. It does not test the web server or PHP
worker queue. Neither number is a tested hosting limit.

Two more **benchmarks** live behind `--suite=` — measurements that inform
a real decision (how the engine behaves, which transport):

| Suite               | What it is                                                    |
| ------------------- | ------------------------------------------------------------- |
| `--suite=engines`   | The engine scenario matrix and invariant sweeps — the harness documented in the rest of this README. `--scenarios=`, `--certify=`, and `--concurrency=` exist only in this suite, so passing any of them selects it without `--suite=` (CI's certify job invokes it that way). |
| `--suite=transport` | Two-browser edit-to-visible latency + wire traffic per transport (`transport/README.md`). |
| `--suite=long-history` | The cost of one commit, and of one idle read, on a room that already holds many stored edits. See "One request on a long history" below. |

The **debugging and analysis tools** — lanes that generate load or
validate projections rather than answer a decision — live in
`tests/debugging/` (see its README). They are deliberately NOT
reachable through `npm run bench`:

```bash
node tests/debugging/soak-transport.mjs \
    engine=intent-log windows=3 soak=3600  # N-window hour-scale soak that
                                           # validates the cost cards
                                           # end to end
node tests/debugging/replay/replay.mjs \
    my-session-clean.json --speed=1        # replay a captured session as
                                           # real HTTP load
```

## Building a data set: result lines and sweeps

One run answers one question. To compare transports, people, post sizes, or
editing patterns, run many setups and collect their results in one file.

**The result line.** `record=<file>` makes the host report append one JSON
line per run to a results file. A line holds the run's setup (engine,
transport, people, post size, pattern, durations, polling interval), where
it ran (plugin commit, Gutenberg pin, PHP, WordPress, MySQL, machine, local
or CI), and a flat list of results. Each result says its phase (`editing`,
`idle`, or `job` for the whole job), its side (`baseline` with the plugin
off, `sync` with it on), its metric, value, and unit, and its kind:

- **counted** numbers are decided by what the software does: requests,
  queries, bytes, memory, rows. They can be compared across machines.
- **timed** numbers also depend on how fast the machine is: PHP CPU time
  and worker time. Compare them only between runs on the same machine.

Rates are per person and minute, so runs with different numbers of
people compare directly. `tests/benchmarks/host/record.mjs` defines every
metric. Metric names and units do not change without a new format version
(`host-benchmark/1` now), so results from different commits stay
comparable — which is also what a later CI check against a saved
reference would need.

**Two more variables.** `post-size=` sets what the post holds before
anyone types: `empty` (one paragraph per person, the default), `medium`
(about 20 blocks), or `large` (about 200 blocks, with headings, lists,
and groups, and each person's paragraph spread through the post).
`pattern=` sets how people edit: `own-paragraph` (every word at the end of
their own paragraph, the default) or `new-blocks` (a new paragraph for
every burst of words). A pattern where everyone types into the same
paragraph is left out on purpose: engines set some of those keystrokes
aside for review by design, so "every editor ends with the same fixed
text" cannot be the check for it.

**Sweeps.** A plan file in `tests/benchmarks/host/plans/` names a center
setup and the variables to change around it:

```bash
npm run bench -- --suite=sweep --plan=scaling --dry-run   # list the runs
npm run bench -- --suite=sweep --plan=scaling             # run them
```

| Plan         | What it answers                                              |
| ------------ | ------------------------------------------------------------ |
| `quick`      | 1 and 2 people, short runs: checks the output path in ~10–15 min |
| `peers`      | 1 to 5 peers, short runs: ~30–40 min |
| `scaling`    | the engine against people (1–3), post size, and pattern      |
| `spread`     | one setup five times: how much each metric moves between identical runs |
| `transports` | the engine over each transport (`websocket` needs the daemon) |

The sweep writes to `bench-results/host/<plan>/`: `results.jsonl` (the
data set), `results.csv` (one row per number, for spreadsheets, pandas, or
R), `chart.html` (a chart page: one drop-down picks the metric; peers go
along the bottom; two flat gray lines show the site without the plugin
while editing and while idle, and each engine has a solid line while
editing and a dashed one while idle; each point is the median of the
repeats), plus each run's log and full JSON report. It
resumes: rerunning the same command skips runs already recorded for the
same commit. It shuffles the run order with a fixed seed, so slow drift
on the machine does not line up with one variable. A sweep takes hours,
so keep the machine awake: on macOS the runner holds off idle sleep
with `caffeinate`, but a laptop on battery still sleeps when its lid
closes. A run refuses any measured span the machine slept through,
since its per-minute rates would count time in which nothing ran.

The result line also measures the editor itself: the longest single
main-thread task any window saw (`editor_longest_task_ms`) and long-task
time per person-minute. A task that long is time the editor does not
answer the person typing.

**How much numbers move between identical runs.** The `spread` plan
(intent-log, short polling, two people, a medium post, 60 s of typing,
5 runs) on an Apple M3 Pro under wp-env, 2026-10-07. Spread is the
lowest-to-highest range as a share of the median:

| With the plugin (sync side)                         | Spread |
| --------------------------------------------------- | -----: |
| Requests, queries, payload, fsyncs while editing    |   ≤ 5% |
| Queries per PHP request, payload while idle         |   ≤ 1% |
| Peak PHP memory, room rows and size                 |     0% |
| PHP CPU and worker share while editing (timed)      |   8–9% |
| PHP CPU and worker share while idle (timed)         | 31–46% |

Counted numbers repeat closely, so a change of more than about 5% in one
is likely real. Timed numbers need more repeats, and while idle they are
too small to compare from a single run. Plugin-off (baseline) numbers
are small, so their relative spread is larger (CPU 37–168%). Counts that
are a few events per run (options-cache writes, idle fsyncs) move in
whole steps, so read them as counts, not percentages.
`node tests/benchmarks/host/spread.mjs results=<results.jsonl>` prints
this for any results file whose setups ran more than once; rerun the
`spread` plan on each machine whose results you compare.

The plugin-off phase does not depend on the engine or transport, so a
sweep measures it once per people/post/pattern/repeat and reuses it for
every run that shares them (`baseline-cache=`). Each repeat keeps its own plugin-off
measurement, so the spread still includes its noise. `export.mjs` and
`chart.mjs` in the same folder rebuild the CSV and the chart from any
results file.

## Community-harness compatibility

The measurement plumbing deliberately speaks the community RTC
performance harness's conventions
([WordPress/distributed-rtc-performance-testing](https://github.com/WordPress/distributed-rtc-performance-testing)),
so numbers and fixtures travel between the two toolchains:

- the same request tags (`X-RTC-Test`, `X-RTC-Scenario`,
  `X-RTC-Approach`, `X-RTC-Poll-Delay`, `X-RTC-Update-Size`, with query
  fallbacks), the same server-side log columns, and the same
  `rtc-test/v1` REST surface (`/log`, `/env`, `/report`,
  `/report-all`) with the same report table layout — the community
  repo's report tooling reads a site running this plugin natively;
- the same capture fixture format in `replay/` (our additive keys —
  `engine`, `transport`, `base_title`, `base_content` — are dropped by
  the community sanitizer and preserved by ours).

Divergences, each deliberate:

- **Approach auto-label.** When a client sends no `X-RTC-Approach`,
  rows are labeled `<engine>/<transport>` — the axis this plugin
  compares — instead of the community's storage-approach labels.
  Additive: an explicit label always wins.
- **Tagged autosave requests are measured too.** A client that tags an
  autosave request adds it to the log.
  Untagged requests are unaffected.
- **Three extra log columns and two extra routes.** Rows carry
  `option_writes` (options-API writes during the measured window —
  the cache-invalidation count) and `php_io_reads`/`php_io_writes`
  (the PHP process's own block I/O via getrusage); the namespace adds
  `/room-size` (storage held by one room) and `/db-io` (the database
  server's disk-I/O counters — the mu-plugin also answers a tagged
  `_rtcdbio` probe with the same counters, which is how the baseline
  phase samples them while the plugin is deactivated). All additive;
  the community report tooling ignores what it does not know.
- **The MU-plugin is optional.** With
  `tests/benchmarks/host/mu-bench-log.php` in mu-plugins (this repo's
  wp-env configs map it), measurement covers the whole request from
  mu-plugin load — the community model — for ANY tagged request, even
  with the plugin deactivated. Without it, the REST lane alone
  measures, starting at plugin load, so `total_cpu_ms` slightly
  understates full-request CPU; `cpu_ms` (dispatch only) is unaffected
  either way.
- **The host report's baseline is "the same site with the plugin
  deactivated"**, not the community's ambient baseline of tagged empty
  polls — a host evaluates against a site without the plugin. The
  transport suite still runs the community-convention baseline phase,
  so its server-side tables normalize the community way.
- **The engines suite has no community equivalent.** It measures the
  engine seam in-process (below); its JSON reports are this repo's own
  format.

---

# The engines suite (`--suite=engines`)

Measures the server sync engine **through the same calls production
makes**: the `WP_RTC_Engine::handle_updates()` / `get_updates_since()`
calls the polling transport makes. So the numbers are the real engine's,
not a model's.

Engines are resolved through the framework's registry (the
`wp_rtc_engines` filter), so **any engine registered by an active plugin is
benchmarkable by slug**. Run `benchmark.php` with an unknown slug to list
what's registered. This plugin registers one:

- **`intent-log`** (`WP_Intent_Log_Engine`) — server-authoritative: the
  server transforms each edit against the log, so it can report exactly how
  every edit settled.

HOW the runner speaks to an engine is an **authoring profile** — a
first-class SPI (`WP_RTC_Bench_Authoring_Profile`) that owns everything
engine-specific: translating the workload's abstract edits into the
engine's wire vocabulary, playing the client's part between requests
(applying read responses, tracking observed state, answering compaction
nominations), classifying void reasons, and scoring quality with an oracle
matched to the engine's merge semantics. The measurement loop
(`WP_RTC_Bench_Runner`) is engine-neutral: it times whatever requests the
profile hands it. Profiles are resolved by engine slug through
`WP_RTC_Bench_Profiles`; an engine plugin can register its own via the
`wp_rtc_bench_authoring_profiles` filter (mapping slug to a class
constructed as `new $class( int $post_id, array $workload )`).

This plugin ships one dedicated profile. The **intent-log profile**
speaks typed intents authored from each client's observed base and scores
quality with the disposition-based oracle. Its client model is
read-driven: each simulated client advances its observed head, register
versions, and per-field text lengths
by decoding the rows the engine actually delivered
(intent rows advance the head one seq each; snapshot rows reset it to
their seq), exactly as the production client derives its baseSeq, and in
the single-process runner every read asserts the decoded state matches
the shared disposition model — so a read path that dropped or mangled a
row fails the run as a convergence failure instead of drifting silently.
Tail-positioned typing authors its insert offsets in EDITOR-TREE
coordinates: the read-observed field length PLUS the length of the
client's own applied-but-unread edits, because the engine's transform
shifts offsets only over priors from OTHER actors (the author's canvas
already contains its own pending edits — authoring from the delivered
length alone lands a deep-lagged client's tail insert mid-token, which
is exactly how the laggy-newsroom convergence gate caught the modeling
gap).
It also models the client's floor-reset recovery: a compaction checkpoint
raises the retention floor mid-round and stale-voids the intents authored
below it, which the production client answers by re-deriving the work
from its editor tree. The profile re-authors each such edit once as a
follow-up ingest after the client's next read, skipping edits whose
target block no longer exists in the observed state (a real client
cannot retype into a block that left its canvas). Every other engine gets
the **opaque-relay fallback profile** — relay-convention
`update`/`compaction` blobs with quality reported as not
server-observable. A third-party relay-style engine benchmarks
meaningfully out of the box; an engine with its own wire vocabulary will
void the generic updates, and the dispositions/storage counts will show
that rather than fake a result — its plugin should register a real profile
instead.

## What it measures

**Cost**:

- `service_us` — per-request service time of `handle_updates` (p50/p90/p99/
  max/mean, reported in ms), measured with `hrtime()` and pooled across
  measured repetitions (warmup reps are excluded). Storage is swapped for an
  in-memory implementation, so this mostly isolates *engine* CPU (the
  intent-log planner and replay; a relay's append) from database I/O —
  with one deliberate exception: the intent-log ingest holds a Core-style
  options-row lock (`WP_RTC_Room_Lock`) for the length of each request
  (its transform log is order-dependent), so each of its samples includes
  one claim/release pair of real DB writes. The reported `calibration`
  block times the lock
  pair and a bare `SELECT 1` in the same environment so the number can
  be decomposed.
- `read_us` / `idle_poll_us` — per-request time of `get_updates_since`,
  split into catch-up reads (during and after the session) and idle polls
  (nothing new to deliver). Idle polls dominate request volume in a live
  deployment, so their cost is reported on its own.
- `join_us` — the later-joiner read: a COLD `get_updates_since` at cursor 0
  by a client that was never in the session, after all the session's
  history — what a fresh visitor pays to enter the room (snapshot + tail,
  per the engine's retention). Its response size is reported as
  `payload_bytes.join_response_*`: the payload that visitor downloads.
- `materialize_us` — the save path: `materialize()` timed on a FRESH
  engine instance per sample (a save request starts with no per-request
  room cache). Engines without the materialize convention report null.
- `memory.ingest_peak_bytes` / `memory.materialize_peak_bytes` — peak PHP
  memory allocated on top of the baseline during the worst ingest and the
  cold materialize (via `memory_reset_peak_usage()`, PHP 8.2+; null
  otherwise) — the number a constrained PHP-FPM pool actually OOMs on.
- `payload_bytes` — request and response sizes of the engine-level updates
  payload (the transport envelope and awareness add overhead on top).
- `storage.rows` / `storage.bytes` — how the room grows. This is measured
  exactly even though storage is in-memory, because growth is a real
  cost, and its kind depends on the engine. The intent log
  checkpoints and trims on the server. A relay-style engine relies on a
  client to compact, and the opaque-relay profile plays that client's
  part: it submits a
  synthetic full-state snapshot whenever a read answers `should_compact` —
  so relay growth reflects a session with live clients, not an abandoned
  room. `storage.followups` counts protocol follow-up ingests generally
  (a relay's compaction snapshots;
  intent-log's floor-reset re-authoring after a compaction checkpoint);
  their requests and dispositions are included in cost and quality.
  `storage.trims` counts history-trim events. The intent-log checkpoint
  path trims once per checkpoint (as does an accepted relay compaction),
  so the server's checkpoint cadence is visible instead of
  hiding as unlabeled spikes in `service_us` p99.

**Quality** — policy-correct, and only where the server can observe it:

- `dispositions` — for the intent log, the count of edits that were
  `applied` (merged), `escalated` (set aside for human review), or `voided`.
- `escalation_rate` — escalated / total. This is **reported, not
  penalized**: sending a genuine conflict to review is the point, not a
  failure.
- `lost_work` — edits that were dropped without being applied or preserved
  for review (a `voided` with a non-benign reason; each authoring profile
  classifies which void reasons are benign for ITS engine). The project's
  policy is *never lose work*; this asserts it. It is `0` in every scenario
  here.
- `converged` — the materialized document matches the engine's own account
  of the session: every `applied` edit's unique token appears in the content
  exactly once, no `escalated` edit's token leaked into the content, the
  block structure is intact, and each block's final attribute value is the
  last applied write in server order. Failures are itemized in
  `quality.convergence_failures`.

**Entity-field registers** (the `set_property`, `set_terms`, and
`set_meta` ops) never materialize
into post content, so their oracle uses the engine's other observables.
Concurrent writes to the same property escalate the later
writer (`property-conflict`, the attr-conflict analog); the profile
asserts every client's wire-decoded property state — what a production
editor would display — equals the last applied write in server order.

All three field ops are the same register lane; only the naming differs.
`set_terms` writes a taxonomy's whole term-ID set
to the register named by its rest_base (`categories`, `tags`), as a
numerically-sorted array. The engine compares term sets
order-insensitively, exactly like the shipping client and the genesis
seed normalize them. `set_meta` writes a registered-meta register,
carried as a flat `meta.<key>` register. The
harness registers the meta palette's keys before genesis
(`WP_RTC_Bench_Workload::register_bench_meta()`) because synced meta IS
registered meta — that is what puts the `meta.<key>` registers in the
genesis seed.

For an engine that merges on the client (the opaque-relay fallback
profile models one), quality is reported as
**not server-observable**: no merge runs on the server, so there is
nothing there to score for convergence or conflict outcome. The harness
says so rather than inventing a number.

### Why not a "merge retention" score

An earlier harness scored quality as *silent-merge retention*: how much
concurrently-typed content survived an automatic server merge. That rewards
last-write-wins — precisely the behaviour this project rejects, because it
silently discards one editor's work. Under that metric a lossy engine that
quietly overwrites can outscore one that surfaces the conflict. This harness
inverts it: the signal is **nothing lost**, with conflicts *surfaced for
review* (an outcome, not a demerit).

## Scenarios

| Slug                  | Shape                                                        |
| --------------------- | ----------------------------------------------------------- |
| `solo-typing`         | One editor, one document. Baseline cost, no contention.     |
| `long-form`           | One editor, ~600 chars per paragraph (~5 KB at defaults). Does cost scale with document size? Combine with `fill=` for a sweep. |
| `parallel-paragraphs` | N editors, each in their own paragraph. Clean concurrency.  |
| `contended-paragraph` | N editors restyling the SAME block. High escalation.        |
| `mixed-newsroom`      | Mostly parallel, ~25% of rounds collide on one block.       |
| `laggy-newsroom`      | Mixed newsroom, but the last client reads only every 10th round: stale bases, deep transforms, heavy catch-up reads. |
| `structural-churn`    | Concurrent block INSERTS and REMOVALS alongside typing — the block-structure stress the pure-typing scenarios never exercise. |
| `remove-contention`   | One client types into an inserted block while ANOTHER client concurrently removes it (the edit-vs-remove conflict class). |
| `field-sync`          | Entity-field register writes (scalar properties, taxonomy term sets, post meta) alongside typing: clean parallel field sync, plus ~25% of rounds where every client writes the SAME register — the register-contention analog of `contended-paragraph`, on the field traffic PR #22 added. |
| `editorial-session`   | A wall-clock session, one round per second: staggered joins/leaves, typing bursts with think-time pauses, every present client polling every round, an autosave every 60 rounds. `rounds=3600 clients=3` is a one-hour three-user session. |

The workload speaks seven operations: `text` (a keystroke batch into a
genesis paragraph, or, in `remove-contention`, into an inserted block
addressed by `block_id`; each carries a seeded abstract position — `head`
or `tail` — that the profiles map to engine coordinates from the client's
own observed state, so typing is not all offset-0 prepends: intent-log
authors the intent's offset from the client's editor-tree field length
(read-observed plus its own pending edits); the token-counting
oracles are position-independent, and under correct transforms a token
can never split mid-token — a split would surface as a missing-token
convergence failure), `attr` (an align restyle), `set_property` (an
entity-property register write — slug, template, …, the field-sync
traffic PR #22 added; title and excerpt are left out of the
palette), `set_terms` (a
taxonomy's whole term-ID set, on the rest_base-named register), `set_meta`
(a registered-meta `meta.<key>` register), `insert_block`
(a new paragraph), and `remove_block` (of a block the same client
inserted earlier; `remove-contention`: any client's earlier insert).
Register contention is modelled on align and on entity fields because
concurrent *text* inserts merge cleanly (the text interleaves — correct,
not a conflict). Structural
discipline keeps the oracles decidable: attr edits target genesis
paragraphs only (identified by delimiter-terminated markers
`Paragraph N;`, never removed), inserted blocks carry unique markers, and
each block is removed at most once. In most scenarios text edits also stay
on genesis paragraphs and removals target only the remover's own earlier
inserts, so every marker's presence in the final document follows purely
from the engine's dispositions. `remove-contention` deliberately relaxes
both rules to produce concurrent edit-into-a-removed-block conflicts and
stays decidable through a scoping rule the profiles share: a text token is
expected in the materialized content iff its edit applied AND its target
block's final state is alive, both facts the dispositions already
determine. Same seed ⇒ same workload.

Clients author from the state observed at their own last read, so a laggy
client's `baseSeq` genuinely lags the server head. After the rounds, every
client catches up, then polls the idle room 25 times — the steady-state
request a live deployment mostly serves.

## Running

The fastest way to the whole picture is the one-command runner
(needs the tests wp-env running — `npm run env:tests start` — with the
bundled Gutenberg built; it activates the plugins itself):

```bash
npm run bench -- --suite=engines     # intent-log x the scenario matrix
                                     # (steady concurrency, deep-lag
                                     #  settlement, structural churn, remove
                                     #  contention, field-sync registers, a
                                     #  10-minute wall-clock session), with
                                     #  result tables and hosting cost
                                     #  cards; FAILS on any lost work or
                                     #  convergence failure
npm run bench -- --engines=intent-log --scenarios=editorial-session
npm run bench -- --certify=10        # invariant sweep: 10 seeds x
                                     # adversarial scenarios + both save-lane
                                     # sessions — certifies "no edit is ever
                                     # silently dropped" at scale; CI runs
                                     # --certify=3 on every push/PR
npm run bench -- --cache=redis       # the host report on a Redis-backed
                                     # site (the Redis Object Cache drop-in
                                     # goes in for the run and comes out
                                     # after); --cache=none is the
                                     # no-cache host.
```

Multi-process concurrency measurement is OPT-IN behind one flag:

```bash
npm run bench -- --concurrency=4     # 4 worker processes, same room, REAL
                                     # table storage: latency including
                                     # genuine lock waits and 503s, vs a
                                     # 1-worker uncontended baseline
```

It complements the modeled queueing on the hosting cost card: the model
composes measured service times with the workload's concurrency histogram
(cheap, deterministic); the measurement runs truly parallel processes against
the shared database (real, noisy, and the only way to exercise the
engine's actual race behavior). No quality oracles run in this mode — it is
a latency and failure-mode probe, with dispositions and void reasons
reported for context.

JSON reports land in `bench-results/`. Individual runs go through wp-cli
directly — the engine needs WordPress (`get_post`, `serialize_block`, and a
`$wpdb` for the ingest lock), so run inside the environment under test.
Options are bare `key=value` tokens — wp-cli would claim `--flags` itself.

```bash
wp eval-file tests/benchmarks/benchmark.php \
    engine=intent-log scenario=mixed-newsroom \
    rounds=200 clients=4 paragraphs=8 seed=42

# Document-size sweep: fill= pads every genesis paragraph to ~N chars
# (8 paragraphs x fill=6000 is a ~48 KB document).
for kb in 0 750 6000 60000; do
  wp eval-file tests/benchmarks/benchmark.php \
      engine=intent-log scenario=solo-typing rounds=50 fill=$kb json=size-$kb.json
done

# A one-hour three-user session (one round per second; join/leave, typing
# bursts, idle polling, autosaves). Start with
# rounds=600 (ten minutes) to see the growth trend.
wp eval-file tests/benchmarks/benchmark.php \
    engine=intent-log scenario=editorial-session rounds=3600 clients=3 reps=1
```

Under wp-env, the plugin is mounted at
`wp-content/plugins/<checkout-dir-name>`:

```bash
npx wp-env run cli --env-cwd=wp-content/plugins/$(basename "$PWD") \
    wp eval-file tests/benchmarks/benchmark.php engine=intent-log
```

Each run executes `reps=3` repetitions of the identical workload and
discards `warmup=1` of them (autoload, opcache, and first-lock costs land
there); timing percentiles pool the measured reps, and per-rep means with a
stddev expose run-to-run spread. Counted metrics are asserted identical
across reps. Add `json=out.json` to also write the full report, which
includes an `environment` stanza (PHP/WP/DB versions, opcache) and the
`calibration` block — always quote those when comparing runs from different
machines.

### The hosting cost card

Wall-clock scenarios (currently `editorial-session`, where one round is
one second) additionally emit a `hosting` stanza — the same measurements
composed into the units a capacity plan multiplies out:

- **requests, PHP-CPU-seconds and engine wire MB per user-hour** —
  client-seconds of presence are counted exactly (every present client
  reads once per round), so the numbers normalize across session shapes;
- **sustained CPU core share** for the whole session — how much of one
  core this session consumed end to end;
- **storage at rest** after the session and **the join payload** the next
  visitor downloads.

The card covers the ENGINE seam only: the transport envelope, HTTP
headers (~0.5–1 KB/request) and awareness traffic add overhead on top —
the transport benchmark (`tests/benchmarks/transport/`) measures those
per-collaborator rates on a live site, and multiplying ITS idle rate into
the card's per-user-hour numbers is the full steady-state bill. A third
lane, `tests/debugging/replay/`, captures REAL editor sessions at the
transport seam and replays them as HTTP load (community-harness fixture
format; see its README) — repeatable full-stack traffic with genuine
engine payloads, complementing this harness's synthetic workloads. Composing
micro-measurements this way still assumes requests don't queue (see
Limitations); a browser-driven multi-client soak to validate the
projections end-to-end is the known remaining gap.

### Comparing runs

`compare.js` renders any number of `json=` outputs side by side — engine
runs, transport-benchmark runs (`tests/benchmarks/transport/`), or a mix;
each kind gets its own table, one column per run:

```bash
node tests/benchmarks/compare.js before.json after.json            # console
node tests/benchmarks/compare.js before.json after.json md=1      # Markdown
```

It warns when engine runs used different workloads (scenario/seed/rounds/
clients/paragraphs) or environments (PHP/DB/opcache) — those numbers are
not directly comparable, and the warning says so instead of silently lining
them up.

## Reading the results

Historical representative run, recorded in August 2026
(`mixed-newsroom`, 150 rounds, 4 clients, 8
paragraphs; wp-env Docker, PHP 8.3 / MariaDB). Run the benchmark for current numbers, and quote your own
`environment` + `calibration` stanzas with any numbers you report:

| Metric              | intent-log       |
| ------------------- | ---------------- |
| service ms (mean)   | ~0.7 (incl. ~0.1 lock pair) |
| service ms (p99)    | ~2.0             |
| idle poll ms (mean) | ~0.0003          |
| storage rows        | 302 (server checkpoints + trims) |
| storage bytes       | ~117 KB (JSON intents + checkpoints) |
| trims (checkpoints) | 3                |
| join (cold read)    | ~0.24 ms, ~113 KB payload |
| materialize (cold save path) | ~2.2 ms |
| ingest peak memory  | ~0.9 MB          |
| quality             | 450 applied, 150 to review, **0 lost**, content-verified converged |

Document-size scaling (`long-form`, one editor in a ~5 KB document, 100
rounds): intent-log mean service ~0.42 ms. The `laggy-newsroom` scenario
(one client reading every 10th round;
part of the engines-suite matrix, at mixed-newsroom size) loses nothing:
intent-log
absorbs stale bases with deeper transforms (~24% escalated, 38 benign
voids, 13 floor-reset re-authoring follow-ups, heavier catch-up reads —
and its deep-stale tail inserts are what force the profile's editor-tree
offset coordinates; see the profile description above).

Structural churn (concurrent inserts/removals + typing, 60 rounds, 4
clients): intent-log merges all 240 edits cleanly, with zero lost work,
convergence-verified through the marker oracle.

Remove contention (one client types into an inserted block another
client concurrently removes; 60 rounds, 4 clients): **intent-log
escalates the trailing edit** (~12% of edits escalate, the trailing
keystrokes parking as `target-deleted`; when the text lands first, both
apply and the token legitimately vanishes with the removed block).
Zero lost work, convergence-verified
under the target-scoped token oracle. This scenario is also where
intent-log's floor-reset retry lane fires visibly (`followups` > 0):
checkpoints stale-void in-flight seed inserts, and the profile re-authors
them like the production client would.

Field sync (entity-property, taxonomy-term, and post-meta register
writes alongside typing; 60 rounds, 4 clients): **intent-log escalates each
later concurrent writer per register** (54 of 240 edits, ~22%, parking
as `property-conflict`). Register traffic is also the cheapest ingest
(~0.5 ms mean, with no text transform). Zero lost work, every
register's final wire state verified against the engine's own account.

A ten-minute `editorial-session` (600 rounds, 3 clients, joins/bursts/
saves; ~850 requests) shows the session-lifetime behavior single scenarios
miss: intent-log holds a flat ~0.7 ms mean throughout. Escalations in the
realistic mix: ~0.1% (bursty non-overlapping typing rarely
collides; 1 of 851 edits). **0 lost**, converged. The hosting cost card
from the same
run: 1.4 CPU-s / 2.2 MB wire per user-hour with 62 KB to
join.

What the numbers say:

- **intent-log** spends real server CPU per request (it transforms and plans
  the merge) and in return keeps storage bounded through checkpointing and
  gives a server-side, policy-correct quality signal — nothing lost, every
  conflict surfaced for review. Under a `contended-paragraph` load (4
  editors on one block) it escalates ~74% and still loses nothing.

## Limitations

- **Single-process, no queueing model.** This measures per-request service
  time and growth, not tail latency under a saturated worker pool.
  The hosting cost card inherits
  this: its CPU/request totals are exact for the session it measured, but
  under real concurrency intent-log requests
  additionally queue on the per-room lock, which the card cannot see. A
  browser-driven host report (`npm run bench -- --peers=N`) measures
  delivery delay and whole-request server costs under growing peer counts;
  these are separate from this engine model.
- **Opaque-relay quality is unmeasured here** by construction (a
  client-merging engine's merge runs in browser clients, outside the
  harness), not by omission.
- **Opaque-relay payloads are synthetic.** Per-edit updates and compaction
  snapshots are size-modelled blobs (a few dozen bytes per keystroke batch;
  a snapshot proportional to accumulated document size), not real Yjs
  binary. On that profile `payload_bytes` and `storage.bytes` are therefore
  order-of-magnitude estimates; `storage.rows` and the compaction cadence
  are exact.
- **In-memory storage** understates absolute per-request time (no real DB
  round-trip for reads/writes) but keeps the *engine* measurement clean;
  storage growth is exact. For end-to-end latency including MySQL, point
  the runner at `WP_RTC_Table_Storage` instead.
- **The intent-log lock IS real DB I/O inside
  `service_us`** (a claim/release options-row pair per
  request), so its
  absolute timings move with the environment's DB latency — a Docker MySQL
  and a local socket differ by an order of magnitude. Use the
  `calibration.lock_pair_p50_ms` figure to subtract it out, and never
  compare `service_us` across environments without the `environment` +
  `calibration` stanzas.
- **Opaque-relay service times sit near the timer floor** (single-digit
  µs): they say "an append-only relay's server cost is negligible", not
  anything more precise.

## Text across paragraph splits

`npm run bench -- --suite=text-slices` measures a fixed 1,000-character
selection after 0, 9, or 99 paragraph splits. It verifies every resulting
format range, then reports JavaScript CPU and wall time, sampled heap growth,
accepted row size, and document snapshot size. Heap growth is not peak PHP
memory. This small core benchmark needs no WordPress site; the engine suite
remains the source for server and storage costs.

## One request on a long history

`npm run bench -- --suite=long-history` answers one question: what does a
single request cost when the room already holds many stored edits? The
engine suite reports an average over a whole session, which hides this.

It runs `tests/benchmarks/long-history.php` in the tests environment,
against the real table storage. For each history size it fills a new room
with that many accepted edits, then measures two kinds of request. Each
measured request builds new storage and engine objects, as a polling web
request does:

- a commit that carries one typed character,
- an idle read that carries nothing and asks for rows after the newest.

```bash
npm run bench -- --suite=long-history
npm run bench -- --suite=long-history --history=0,450,950 --samples=30 --json=out.json
```

The engine saves a full snapshot every 500 accepted edits and trims the
rows before the previous snapshot, so stored history tops out near 1,000
edits. Keep `history + samples` away from a multiple of 500, or a measured
commit also pays for a snapshot. There is no HTTP and no transport in
these numbers.
