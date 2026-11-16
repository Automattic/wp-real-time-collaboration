# Docs

About an hour's reading, in this order.

**Orientation**

- [data-flow.md](data-flow.md) — how one edit reaches the other
  editors, in the Gutenberg experiment and in this plugin.
- [transports.md](transports.md) — how updates move: polling and the
  advisory channel, the sync daemon's WebSocket,
  what happens to unsaved changes, presence on slow connections, and
  what a host must provide.
- [protocol.md](protocol.md) — the routes, the room envelope, the row
  types, who may do what, and how to add an engine.
- [storage.md](storage.md) — the two tables, the keys the engine
  writes, the object cache, presence, and the lifecycle commands.
- [conflict-review.md](conflict-review.md) — how a set-aside change is
  shown in the editor and decided: the record the engine publishes,
  the cards and dialogs, and what the engine does with a decision.

**Rules and reference**

- [principles.md](principles.md) — the seven principles the plugin is
  judged by, and an early decision still open.
- [wontfix.md](wontfix.md) — what we decided not to do, and why.
- [glossary.md](glossary.md) — the project's own words, in plain words.

The pages carry no measured numbers; `npm run bench` produces them on
your hardware. Notable shipped changes are in `CHANGELOG.md`, how to
work in the repo is in `AGENTS.md`, and open work lives in GitHub
Issues (`CONTRIBUTING.md` has the filing rules).
