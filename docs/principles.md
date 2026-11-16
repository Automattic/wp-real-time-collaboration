# Core principles

These seven rules are the acceptance criteria this project is judged
against. They are not aspirations. They synthesize the team's problem
statement and principles. Every engine decision is measured against
them, and every violation is named — including the ones our own porting
choices introduced.

- **P1 — The server is the authority.** WordPress stands in the path of
  every update: it checks who sent it, records who, and can read it
  as it arrives. A relay that cannot say who wrote what cannot enforce
  permissions: an admin's save must never make a script tag an author
  injected into the shared document look safe.
- **P2 — No edit is ever silently lost.** Reloads, network loss, delayed
  saves, out-of-band writes: the design must degrade toward escalation
  and review, never toward disappearance. The benchmark's zero-lost-work
  oracle certifies this per engine on every scenario.
- **P3 — Real conflicts are surfaced, not hidden.** "Conflict-free"
  hides conflicts. When changes overlap meaningfully, the system detects
  it and asks a human, while taking care not to overburden humans with
  constant review. How often an engine asks, on a workload where people
  clash, is measured on purpose: too often means the merge is weak, and
  never means conflicts are being hidden.
- **P4 — Collaboration is not just for humans.** Agents, CLI tools,
  REST/XML-RPC integrations, and plugins must be able to use existing
  WordPress APIs without disrupting collaborative sessions — and ideally
  participate in them meaningfully. A scheduled integration that
  read-modify-writes a post must not erase five minutes of two editors'
  work with no record that a conflict existed.
- **P5 — Cheap hosting is normal hosting.** Functional everywhere,
  progressively enhanced where the host commits resources. Nothing on
  the core path may assume database or process topology beyond what
  WordPress Core itself assumes. Locks, in particular, must be
  implemented the way Core would implement them.
- **P6 — Host economics are measured, not asserted.** Resource usage is
  demonstrated with repeatable benchmarks. These pages
  deliberately carry no numbers (they go stale and mislead); they
  describe stable shapes and point at `npm run bench`.
- **P7 — Capture intent and identity, not snapshots.** Semantic
  operations ("split block", "move block") and stable block identity
  make merges match what the user actually did. Diffing before/after
  snapshots reconstructs a guess — and a guess is what mangles prose
  when edits collide.

## An early decision still open to revisiting

One choice made before the engine existed is cheap to change now and
expensive later.

- **The official copy lives in plugin storage.** The shared working
  copy lives in the room tables, not in the post. The original
  Distributed Editing design keeps it in the post itself, with
  revisions as backup (see [wontfix.md](wontfix.md)).
