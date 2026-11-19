# Things we decided not to do

Each item says what the idea is and why it waits. The reason matters
more than the idea: it tells you whether the reason still holds when
you come back. Open work lives in GitHub Issues; nobody should start on
one of these without filing an issue first.

- **Storing the shared document in the post itself.** Today the shared
  working copy lives in its own tables. The original Distributed Editing
  design keeps it in the post content, with revisions as the backup.
  *Why it waits:* it changes where the truth lives, so
  it is its own project.
- **Four intent-log limits we accept.** Edits not yet sent are lost if
  the tab reloads (undo makes this visible). Typing into a paragraph a
  colleague is editing, before their change has arrived, sends the later
  keystrokes to review instead of merging them. A script cannot send
  typed edits directly; it can only save with a declared starting
  version. A script that overwrites a post without one goes unnoticed.
  *Why they wait:* each is understood, none loses work silently, and
  they are the price of the design rather than defects in it.
- **Quieter review cards when there are many.** The pending-edit cards
  sit open in the canvas; with many conflicts at once that could get
  busy. *Why it waits:* nobody has hit it yet.
- **Sending our changes upstream.** Two things we carry belong
  elsewhere: our changes to the bundled Gutenberg, and a fix for a
  login race in a test helper.
  *Why it waits:* each means talking to another project, a person's job.
- **New engines, new transports, a history slider, and
  hover-to-see-who-wrote-this.** Not planned. The last two have their
  data available already; no interface work is scheduled.
