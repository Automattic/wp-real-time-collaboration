# AGENTS.md

How to work in this repo: the environments, the tests, the diagnostics,
and the rules. What the plugin is and how it behaves is in `README.md`
and `docs/` (start at `docs/README.md`). A room, below, is one post's
shared editing session.

## Language

- IMPORTANT: Write clear, short sentences as if explaining things to a
  less-technical friend. Avoid all technical jargon and self-invented
  terms. Do not use abstract structural metaphors or shorthand arrow
  chains.
- Practice "BLUF": Bottom Line Up Front. Start with the main point or
  conclusion, then provide supporting details.
- Be as concise as possible without omitting essential information.
- Before posting something for external consumption, run the draft past
  a fresh subagent instructed to flag jargon and follow these language
  rules. Use a model that is skilled at summarizing.
- If a word is defined in `docs/glossary.md`, it is one of our invented
  words and belongs in code and design pages, not in an issue's title,
  problem, or example (`CONTRIBUTING.md` has the rule). Code
  identifiers in backticks are always fine, and this file and the
  docs may use a glossary word once it is explained nearby.

## Repo layout

- `wp-real-time-collaboration.php` — plugin entry.
- `includes/` — server PHP: `server/` (what Gutenberg used to provide:
  the engine and transport contracts and registries, room names and
  permissions, routes, the settings printed for the browser, the on/off
  setting, the fallback storage), `engines/intent-log/` (the one
  engine), `shared/`, `transports/` (polling and `websocket/`),
  `admin/` (the settings screen), `storage/`, `diagnostics/`
  (dev-only).
- `src/` — client TypeScript; `src/index.ts` builds
  `build/sync-engines.js`: `engines/` (the intent-log core, its session,
  and the comparison of two documents), `replica/` (one room's state in
  the browser: the documents and the one list of everything the server
  has not answered), `shared/`,
  `registry/` (the plugin's own transport and engine registries,
  connection errors, and the types an engine and a transport share),
  `providers/{http-polling,websocket,advisory}/`,
  `awareness/`, `review/` (the conflict review cards
  and dialogs; see `docs/conflict-review.md`),
  `editor/` (the only folder that talks to the editor.
  `gutenberg-contract.ts`: every non-public thing the plugin relies on
  from Gutenberg goes here. `register.ts` hands the engine to core-data.
  `provider.ts` is the object core-data calls for loads, edits, saves
  and undo. `capture.ts`, `identity.ts` and `text-change.ts` turn
  core-data's edit batches into engine edits, `apply.ts` builds editor
  blocks from the document, `load.ts` matches blocks when a post opens,
  `post-fields.ts` syncs the title, terms and meta, `block-types.ts`
  reads block type definitions, `undo-history.ts`,
  `review-decisions.ts` and `collections.ts` hold undo, review
  decisions and the list rooms), `debug/inspector.ts`.
- `gutenberg/` — a copy of Gutenberg's `try/sync-engines-intent` branch,
  source only, pinned by `gutenberg-pin.json` (`commit`, `trunk`, and
  `tree`, which must equal `git rev-parse HEAD:gutenberg`). The plugin
  loads it when no standalone Gutenberg is active. To update it,
  replace the folder from a Gutenberg checkout (`rm -rf gutenberg`,
  then `git -C <checkout> archive --prefix=gutenberg/ <commit> | tar -x
  -C .`), apply the changes listed under `local_changes` in the pin
  again, update the pin, install and build, and run typecheck, Jest and
  the browser tests. The new folder must be staged (`git add
  gutenberg`) before it builds: one build step asks git which icon
  files are tracked. The release zip includes the built copy.
- `tests/` — `phpunit/`, `js/` (Jest, mirroring `src/`), `e2e/`
  (Playwright specs, config, fixture plugins, launchers in `bin/`),
  `benchmarks/`, `debugging/`, `fuzzer/`, `tools/`; each of the last
  four has a README.
- `bin/` — `build-plugin-zip.sh` and `release.mjs` (humans only).
- `blueprint.json` / `blueprint.local.json` — Playground blueprints.
- `examples/advisory-relay/` — the bring-your-own relay a host copies,
  with its protocol in its README.

## Setup

The commands are in `README.md` (Development). The bundled Gutenberg
build (`cd gutenberg && npm ci --ignore-scripts && npm run build`) is
needed for Jest and `npm run typecheck` too, because they resolve the
editor packages from it; `--ignore-scripts` skips its Husky hook, which
needs its own Git root. Gutenberg installs its dependencies per
package (`gutenberg/packages/<name>/node_modules`, linked into
`gutenberg/node_modules/.store`), so `gutenberg/node_modules` holds
almost nothing by itself. `jest.config.js` and `tsconfig.json` point at
the package folders for that reason.

## Environment

Two SEPARATE wp-env configs, each a single site:

```bash
npm run env start         # DEV env (.wp-env.json), http://localhost:8888;
                          # its afterStart hook starts the sync daemon
                          # (detached; the transport selection is NOT touched)
npm run env:tests start   # TESTS env (.wp-env.tests.json), http://localhost:8889,
                          # Redis only; what test:php / test:e2e / CI target.
                          # It pins the transport to http-polling with the
                          # WP_COLLABORATION_TRANSPORT constant (the plugin's
                          # default is websocket). A stored transport option
                          # wins over the constant, which is how the WebSocket
                          # suite and the fuzzer switch.
npm run env:stop          # Stops Redis + WordPress (env:tests:stop for tests)
npm run cache:on          # Puts the Redis Object Cache drop-in in (the file that
                          # makes the object cache persistent); cache:off removes
                          # it; cache:tests:on/off for the tests env. Both configs
                          # leave it OUT, so the suites run without a persistent cache.
```

Each config's `afterStart` hook (a wp-env lifecycle script) starts a
Redis container as `sync-redis`. Redis serves only the optional
persistent object cache; no transport uses it. A
Redis that fails to start does not fail the environment. Plain `wp-env
stop` (and `npm run env stop`) leaves Redis running; use `npm run
env:stop`. With the object-cache drop-in on, the whole site goes through
Redis, so measurements describe a Redis-backed host. The benchmarks
switch this per run (`cache=none|redis`) and restore it.
`autoPort` is on, so a busy port makes wp-env pick another and print
it; force one with `WP_ENV_PORT`. Each config has its own work dir
under `~/.wp-env`, databases included. Personal overrides go in
`.wp-env.override.json` / `.wp-env.tests.override.json`.

`npm run playground` needs no Docker: a local WordPress Playground at
http://127.0.0.1:9400 with `blueprint.local.json` applied (both plugins
active, a second account `editor` / `password`). The checkout must be
BUILT first; PHP edits are live, JS edits need `npm run build`. There is
no daemon and nothing persists. `--login` is pinned because the
blueprint's `login: true` alone does not log a browser in; `--workers=1`
because with several PHP workers the editor shows "Session expired" at
random.

## Testing

```bash
npm run test:js             # Jest: engines/providers + frozen-core vectors
npm run test:vectors        # stored test vectors equal fresh generator output
npm run test:php            # PHPUnit in the wp-env tests container
npm run test:e2e            # Playwright: two-browser collaboration (+ http-only)
npm run test:e2e:websocket  # websocket-only suite (runs the daemon)
npm run lint:docs           # the prose against the code (see Commits / PRs)
```

Iterate at the cheapest layer that can catch the change, fast to slow:

1. `node tests/tools/sweep.js [seeds] [steps] [clients]` (defaults
   60/400/3; no WordPress): the first check for any intent-log planner
   or merge change. `npm run test:sweep` runs it with the defaults.
2. `npm run test:js` (needs only the built subtree).
3. `npm run test:php`.
4. `npm run test:e2e` (minutes).
5. `npm run fuzz:quick` as a post-change smoke; the full `npm run fuzz`
   matrix for bug hunting (`tests/fuzzer/README.md`).

Single-test loops: `npm run test:js -- sync-id` (files matching),
`npm run test:js -- -t 'name'`, `npm run test:php -- --filter Class`,
`npm run test:e2e -- collaboration-intent-log`,
`RTC_E2E_ENGINE=intent-log npm run test:e2e` (one engine's slice; CI
runs one e2e job per slice, selected by `@engine-<slug>` in the describe
title, and `RTC_E2E_ENGINE=none` runs the untagged specs; `intent-log`
and `none` are the only values).

Test traps:

- Never run `test:php` while an e2e run is in flight against the same
  env: PHPUnit wipes the tests database. Serialize the suites.
- `test:php` leaves this plugin and the Presence API plugin INACTIVE; a
  daemon suite started next fails with `Error: 'collaboration' is not a
  registered wp command.` Reactivate both first (this plugin requires
  the Presence API, so activating it alone fails):
  `npx @wordpress/env --config .wp-env.tests.json run cli wp plugin activate presence-api wp-real-time-collaboration`.
- `test:php` and `test:e2e` need the running TESTS env with the subtree
  built, and e2e needs `npx playwright install chromium` once. If the
  tests site is not on `:8889`, pass `WP_BASE_URL`. If ANOTHER
  project's wp-env holds `:8889`, Playwright silently reuses that site
  and the first failure is a global-setup REST call dying with
  "Unexpected end of JSON input"; `npm run doctor` detects this.
- The transport suite:
  - `websocket-only` under `test:e2e:websocket`:
    `tests/e2e/bin/rtc-real-ws-daemon.mjs` selects the transport,
    publishes the daemon on host port 8787, runs the example relay on
    8790, and restores the transport at teardown.
  - The polling cadence rules have Jest coverage in
    `tests/js/providers/http-polling/polling-manager-cadence.test.ts`;
    iterate there first. Playwright cannot hide a tab, so the specs
    override `document.visibilityState` in the page and fire
    `visibilitychange`.
- `npm run rtc:ws` starts the real websocket transport for manual
  two-window testing (the daemon must bind 0.0.0.0 with port 8787
  published; wp-env alone cannot publish extra ports); `npm run
  rtc:http` switches back. The DEV env's `afterStart` hook does the same
  with `--mode=daemon --detach`; with several worktrees the most
  recently started dev env owns port 8787.

## Diagnostics

- `npm run doctor` — read-only preflight: builds, both environments,
  the worktree plugin-copy arrangement, whether the plugin loaded, the
  engine and transport options, the foreign-wp-env trap, the Redis
  drop-in, daemon health. Uniform timeouts across every suite are an
  environment failure, not an engine bug.
- `window.wpSync` on every editor page (`src/debug/inspector.ts`):
  `enable()`, then `tail()`, `log()`, `table()`, `intents('p1')`,
  `doc()`, `proposals()`, `cursor()`, `export()`, `help()`. Enabling it
  also makes the engine add a `_debug` section to its answers (gated
  by `SCRIPT_DEBUG` or the `wp_sync_debug_enabled` filter).
- Query Monitor's `qm/debug` action receives lock timeouts, edits held
  back or thrown away, repairs, snapshots, trimming and engine
  mismatches.
- `wp collaboration rooms list|inspect` (dev-only) and
  `wp collaboration storage status` (`docs/storage.md`);
  `wp collaboration capture start|stop|list|export|drop` records real
  sessions for `tests/debugging/replay/`, and requests tagged
  `X-RTC-Test: 1` get per-request server metrics
  (`wp collaboration bench-log report`).
- The fuzzer writes `summary.md` with failure signatures and replay
  commands; `--shrink` bisects a failure; `RTC_FUZZ_LOG_SYNC=1` captures
  wire summaries. `tests/tools/observe-two-tab-sync.mjs` is the manual
  two-tab observer.

## Traps

Things that have bitten before: facts about this codebase and its tools
that are easy to get wrong and expensive to rediscover. Read this
before a big change. A durable lesson from an issue goes here.

### Rules that must not be undone

- **intent-log saves a full snapshot every 500 changes, not 100.** The
  smaller number crossed mid-typing and threw away edits still in
  flight.
- **The engine applies a review decision; the review code never
  writes to the post.** The engine publishes its set-aside changes as
  records (`src/review/types.ts`) and applies the reviewer's accept or
  dismiss itself. An accept names the current side the reviewer saw,
  and the registry (`src/review/conflicts.ts`) refuses it when that
  side moved on. A card waits for the author's typing only when the engine
  promises that later typing joins the same record (`followsTyping`).
  Block editors inside the dialogs carry the document's own block ids,
  so everything inside a dialog is wrapped in `ReviewSurface` or the
  cards render inside it. The rules and the engine's part:
  `docs/conflict-review.md`.
- **Unsent work lives in one place: the replica's outgoing list**
  (`src/replica/replica.ts`). A transport keeps no queue. It asks the
  session what to send (`takeUpdatesToSend`) and tells it when a
  request or a socket was lost (`connectionLost`), and the session
  hands the same updates out again. A second copy of unsent work in a
  transport is how an edit sent on a dying socket used to be lost.
- **A change made inside `gutenberg/` is listed under `local_changes`
  in `gutenberg-pin.json`** until the Gutenberg branch has it too, and
  must be applied again when the folder is replaced. The list is empty
  when the copy equals the pinned commit.
- **The review dialogs use the editor package's revision comparison**,
  a private export that so far only this Gutenberg branch has (read
  through `src/editor/lock-unlock.ts`). Another Gutenberg lacks it, so
  the dialogs check `hasBlockDiff` and `hasCodeDiff`
  (`src/review/revisions-diff.ts`) and show a text comparison instead;
  a new use of those names needs the same check.
- **The intent-log core is frozen: do not edit it casually.** The
  core (`src/engines/intent-log/`) is kept identical to its PHP twin
  (`includes/engines/intent-log/`) through JSON test vectors kept in
  two copies, `tests/js/engines/intent-log/test-vectors/` and
  `tests/phpunit/test-vectors/`. Regenerate with the `tests/tools/`
  generators and always update both. A JSDoc-only edit is fine.

### Dead ends: do not retry these without new information

- **Fixing jumbled fast typing by changing when old log entries are
  deleted.** Three attempts, all partial. Deleting later made it rarer;
  waiting until nobody is typing did not close it. The
  remaining fix is the cause: a table keystroke writes three history
  entries instead of one (issue #37).
- **Recovering a lost edit by asking the editor for the post's current
  state.** The obvious call returns nothing for some block shapes. Keep
  a reference to the last block tree the editor handed over and re-read
  that.
- **Syncing buffered work the moment the first message arrives.** The
  first message is only the first of a burst, and the rest arrives right
  behind it. Acting at once duplicated every saved block. Wait until the
  burst is over, then check whether the work is still needed.
- **Reading the soak test's per-minute numbers as rates.** They are
  running totals. Subtract before concluding.
- **Writing a change into the editor from inside `applyEditBatch`.**
  core-data hands the provider a local edit BEFORE it stores it, so
  that store replaces any `editRecord` made during the call. This is
  deterministic, not a race. A change that reacts to the editor's own
  edit must be written in a later task, after the call returns (see
  `pushLater` in `src/editor/provider.ts`). Changes written from a
  transport callback work normally. The symptom is an editor whose
  blocks silently never get their syncIds.

### Code facts that look wrong but are right

- **A room remembers the engine that first wrote it**, and the
  transport answers HTTP 409 to a tab speaking another engine. Rooms
  not tied to one post are reset when a tab speaking the new engine
  arrives; per-post rooms are not, because they can hold unsaved
  content.
- **The server's first copy of a post (genesis) has no default
  attribute values.** It is built from the block comments, which leave
  defaults out, while the editor's blocks always carry them (a
  paragraph's `dropCap: false`). Sending an unchanged default as an
  edit makes two tabs' first edits clash on every such block.
- **A tab takes its own unanswered typing out of its document before
  the server says it was set aside.** The tab sees the clash itself
  when the other person's edit arrives (`getPredictedSetAside` in
  `src/engines/intent-log-session.ts`). The review record opens only
  with the server's answer. A write to the editor between those two
  moments removes the text under the caret, and the letters typed next
  go into a different text than the ones before. So `shouldHoldPushes`
  in `src/editor/provider.ts` waits from the first moment.
- **The storage's `get_cursor()` and `get_update_count()` are
  per-request caches refreshed only by `get_updates_after_cursor()`**,
  kept that way from the fallback storage on purpose. Do
  not decide anything from them before a read has run.
- **The first copy of a post's blocks the server builds (genesis) must
  set `isValid: true`** on every block, or the editor renders them as
  invalid-content recovery blocks.
- **`src/awareness/registry.ts` must register the `gseBlock` presence
  field in every mode.** A peer can send the field at any time, and
  core-data throws on an unknown field.
- **The block name for slow awareness is sent with the presence data
  that already travels.** Under the Heartbeat channel an advisory
  channel must be selected. The e2e spec turns the advisory channel off
  for its duration.
- **A post admits five editor tabs, so the sixth is refused** ("Too
  many editors connected"), checked once on the page's first
  connection. Give extra test tabs their own post, or raise
  `sync.pollingProvider.maxClientsPerRoom`.

### Environment and test traps

- **Some tests are expected failures on purpose.** Each states the
  correct behavior for a known defect and passes while the defect is
  there: `tests/js/known-defects/` (`it.failing`), and in PHPUnit a
  test whose assertions are wrapped in `assert_known_defect()` (the
  trait `tests/phpunit/fixtures/trait-known-defect-assertions.php`;
  `RTC_KNOWN_DEFECTS_RAW=1` shows the real failures; no PHPUnit test
  uses it now). A defect that
  only a browser can show gets a Playwright test marked `test.fail`.
  A fix turns its test red. Remove the marker then, not the test.
- **Stop a site before starting it again on its port.** `autoPort`
  finds the port busy with the site's own container, so a second
  `npm run env:tests start` (or `npm run env start`) leaves the
  container on the old port and stores the next free one (8890) as the
  site's address. Every page then redirects to a port nothing listens
  on, and the browser suite's setup times out. PHPUnit still passes,
  because it makes no HTTP request. Run `npm run env:tests:stop`, then
  `WP_ENV_PORT=8889 npm run env:tests start`. A changed constant in the
  config needs the same restart.
- **A benchmark needs the machine awake.** A laptop that sleeps in the
  middle of `npm run bench` gives wrong per-minute numbers and no
  error. The sign is a run that took far longer than its settings say.
  On macOS, start it with `caffeinate -i -s`.
- The WordPress Playwright helpers fall back to port 8889 and to this
  suite's saved login. A second Playwright setup in this repo must set
  `WP_BASE_URL` and `STORAGE_STATE_PATH` itself, as
  `tests/tools/edit-batch-recorder/playwright.config.mjs` does.
- `jest.config.js` sets `roots: [src, tests]`; without it Jest recurses
  into the subtree's ~1030 suites. `phpcs.xml.dist` excludes
  `/gutenberg/*`.
- `@wordpress/scripts` does NOT bundle wp-env; it is pinned to
  `@wordpress/env@^11` with an `overrides` entry that clears the
  ERESOLVE. Composer pins `phpunit/phpunit:^9.6`; PHPUnit 10 removed a
  method WordPress's bootstrap calls.
- `tests/bootstrap.php` loads the bundled Gutenberg, then the plugin,
  then the test fixtures on `plugins_loaded` at priority 20. The
  fixtures need the plugin's own classes, which load when it boots on
  that hook.
- e2e must load a single `@playwright/test`: the subtree's `npm install`
  re-creates its own copy, and `pretest:e2e` removes it. The runner is
  `playwright test` directly, NOT `wp-scripts test-e2e`.
- `tests/e2e/config/global-setup.ts` activates the plugin by file path
  (wp-env leaves mapped plugins INACTIVE on the tests site) and
  deactivates a stale `gutenberg-stub` from an aborted precedence run.
- Collaboration is on while the plugin's `wp_rtc_enabled` option is.
  The plugin answers Gutenberg's `wp_is_collaboration_enabled` filter
  with it, and Gutenberg's own real-time collaboration experiment has
  no say while the plugin is active. Activation turns the option on.
  The client flag is `window.__experimentalEnableRealTimeCollaboration`,
  which Gutenberg prints (false in the site editor).
- Built subtree JS lands at `gutenberg/build/scripts/<pkg>/`.
- A checkout in a folder with any name other than
  `wp-real-time-collaboration` (a git worktree, for example) is mounted
  twice: `.wp-env.json` lists `.` in `plugins`, which mounts it under
  the folder's name, AND maps `.` to
  `wp-content/plugins/wp-real-time-collaboration`. A checkout whose
  folder has that name is mounted once. Activating both copies is a
  fatal `Cannot redeclare gutenberg_sync_engines_bootstrap()`. Keep the
  DIRECTORY-NAME copy active: `wp-env start` re-activates it on every
  start, so the reverse arrangement aborts the next start. `npm run
  rtc:ws` enforces this.

## Coding standards

- PHP: `composer lint` / `composer format`; keep lint at zero errors and
  zero warnings, and never widen the excludes. JS/TS: `npm run lint:js`
  + `npm run format`. JSON is two-space; everything else keeps tabs.
- The frozen intent-log core and the
  generated test vectors are excluded from prettier on purpose
  (see Traps). JSDoc-only edits to the core are fine.

## Commits / PRs

- **`CHANGELOG.md` records significant changes only** (a new feature,
  setting or extension point, or behavior that changes), under
  **Unreleased**, as part of the change itself, one or two sentences
  with the issue linked. Not bug fixes, tests, tooling, refactors or
  docs; the release script lists every merged commit anyway.
- **A change to a default, an option name, a filter, a transport slug,
  a REST route or a row type updates the settings screen's text
  (`includes/admin/class-gutenberg-sync-engines-settings.php`) or
  `docs/protocol.md` in the same commit.** `npm run lint:docs` (CI)
  checks that every path, option, filter, class and constant the docs
  name exists in the code, that links and anchors resolve, that
  `docs/README.md` lists every page, and that a number wrapped in a
  `const:` HTML comment matches the code. It checks the docs against
  the code, not the other way round: it cannot tell when a changed
  default leaves a sentence stale, or when a new filter is documented
  nowhere.
- Commit with `--no-verify` (the pre-commit hook is heavy). Signing
  follows the checkout's git config; do not turn it off.
- Do **not** open PRs, push to shared branches, or take other
  outward-facing actions unless the user names that specific action.
- **Releasing is human-only.** Never run `npm run release`, trigger a
  release workflow, push a `release/*` branch, tag, or bump the version.
  Use `@since n.e.x.t` in new code.

## Issues and the loop

Open work lives in GitHub Issues (`gh issue list --label "agent:ready"`).
A new issue needs two things: what happened, and what you expected. It
arrives labelled `agent:needs shaping`. An agent investigates and
rewrites it into the shape in `.github/ISSUE_TEMPLATE/shaped-issue.md`
(what happens now, an example with numbered steps, what should happen,
how we will know it is done, notes), then moves the label to
`agent:ready`. An `agent:in progress` label means someone claimed it
(add the label and assign yourself in one step, and release it when
you stop); `agent:parked` means it cannot move and a comment says
what it needs.

Notes about what one cycle did go on the issue as a comment;
a durable lesson goes in the Traps section of this file.

One issue is one thing. Do not hard-wrap issue bodies: GitHub shows
every newline, so one paragraph is one line.
