# Edit batch recorder

Records what Gutenberg's `try/sync-engines-intent` branch sends to a sync
provider, for a fixed list of editor actions. The recordings are in
`tests/fixtures/edit-batches/`, one JSON file per action, plus
`tests/fixtures/edit-batches/facts.json` with the answers to open
questions about the contract.

Run it again when the Gutenberg branch changes, and compare the files
with `git diff`. Block ids change on every run, so look at the
operations, not the ids.

## What is here

- `plugin/` is a small WordPress plugin for the recording site only. Its
  PHP turns collaboration on through Gutenberg's two filters. Its
  script registers a sync provider that syncs nothing and writes down
  every call core-data makes.
- `record.spec.mjs` drives a real editor through the actions and saves
  the log. `playwright.config.mjs` and `global-setup.mjs` are its
  Playwright setup.

## How to run it

The recording site is not one of this plugin's two wp-env sites. It is a
plain Gutenberg site built from the branch under test.

1. Make a scratch copy of the Gutenberg branch outside this repository
   and outside the Gutenberg checkout. `git archive` does not touch the
   checkout's working files:

   ```bash
   mkdir -p /tmp/gb && git -C <gutenberg checkout> archive \
     --prefix=gutenberg-intent-scratch/ <commit> | tar -x -C /tmp/gb
   ```

2. Build it. The build needs the folder to be a git repository with its
   files added, because one build step asks git which icon files are
   tracked:

   ```bash
   cd /tmp/gb/gutenberg-intent-scratch
   git init -q . && git add -A .
   npm ci --ignore-scripts && npm run build
   ```

3. Add a `.wp-env.override.json` there that gives the site its own port
   and loads the recorder plugin:

   ```json
   {
     "port": 8895,
     "plugins": [ ".", "<this repository>/tests/tools/edit-batch-recorder/plugin" ]
   }
   ```

4. Start the site and switch to a block theme:

   ```bash
   npx wp-env start
   npx wp-env run cli wp theme activate emptytheme
   ```

5. From this repository, record:

   ```bash
   npx playwright test --config tests/tools/edit-batch-recorder/playwright.config.mjs
   ```

   Add `-g <name>` to record one action. Set `WP_BASE_URL` for another
   port, `GUTENBERG_COMMIT` to stamp another commit into the files, and
   `EDIT_BATCH_OUTPUT_DIR` to write somewhere else.

The config sets `WP_BASE_URL` and `STORAGE_STATE_PATH` itself. Without
that, the WordPress test helpers fall back to port 8889 and to the login
cookies of this plugin's own tests site.

## The file format

```
scenario, description     what was done
gutenbergCommit           the branch commit that was recorded
initialContent            the post content before the action
clientIdsFromLoad         block ids core-data passed to load()
clientIdsInEditorAtStart  block ids the editor held afterwards
startupEvents             every call before the action began
events                    every call during the action, in order
editorTreeAtStart/AtEnd   the block editor's tree before and after
editedContentAtEnd        the post content after the action
```

An `applyEditBatch` event holds the batch as core-data sent it, the
block tree core-data held just before it (`treeBefore`), and the tree it
held in the next task (`treeAfter`). Trees are saved only for batches
that hold a block operation. `openedUndoLevel` marks the batches for
which the recorder reported a new undo step.

JSON cannot hold some values, so they are written like this:

```
a rich text object   { "__type": "RichTextData", "html": "...", "text": "..." }
undefined            { "__type": "undefined" }
a function           { "__type": "function" }
```
