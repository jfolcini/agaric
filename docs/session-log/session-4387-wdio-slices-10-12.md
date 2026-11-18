# Session 4387 — WebdriverIO shrink, slices 10–12 on the bridge, and the mock's redo divergence

Slices 10, 11 and 12 of #6926, shipped as one PR at the maintainer's request to save CI runs: one commit per slice, plus a mock fix for #6978. Each slice adds Playwright specs to `REAL_BACKEND_SPECS`, ports WebdriverIO specs into them and deletes those.

## What shipped

**Slice 10 (undo):**
- **Specs:** `block-undo-chains-page-undo`, `undo-redo-blocks`, `kind-change-undo`, `reload-keeps-editor`, `escape-keeps-text`, `escape-right-after-enter-cleans-blank`, `batch-toolbar-actions` and `features-coverage` join the bridge.
- **Deleted:** WDIO `undo-todo-state`, `kind-change-undo` and `history-redo-revert-restore`.
- **Clock rework:** `page.clock` does not reach the backend. `reload-keeps-editor` now waits out the real undo-group window (`outlastUndoGroup`, `UNDO_GROUP_WINDOW_MS`, shared in `e2e/helpers.ts`), because after an agent or peer write the undo falls back to `undo_page_group`, which groups by backend timestamps. `kind-change-undo` keeps `page.clock`: its undos go by op refs, which the browser's clock groups.
- **Rewritten tests:** `undo-redo-blocks`' create and redo tests passed only on the mock, or vacuously; they are rewritten. history-revert's "batch revert reverses a create_block operation" gives its block content so the revert can fail.

**Slice 11 (lists and tasks):**
- **Specs:** `task-list-kind`, `list-marker-only-lists`, `list-style-keyboard`, `typed-metadata-one-leave`, `date-chip-editing`, `slash-commands-happy-paths`, `week-cross-day-clipboard`, `block-ref-count`, `block-ref-peek`, `block-linked-references`, `paste-spliced-5160` and `paste-one-line-names-6033` join the bridge.
- **Deleted:** WDIO `week-cross-day-clipboard`, `paste-splice` and `paste-foreign-syntax`.
- **Test changes:**
  - `date-chip-editing` sets its agenda due date in the test.
  - Two `@real-only` paste tests assert normalisation the mock lacks (#5071).

**Slice 12 (links and tags typed):**
- **Specs:** `at-tag-prose-6530`, `emoji-in-titles-and-tags` (now re-reads the stored block and tags), `hash-tag-typing`, `inner-links`, `link-labels`, `outgoing-links`, `picker-happy-paths`, `table-cell-link-backlink` and `tag-chip-color` join the bridge.
- **Deleted:** WDIO `hash-tag-typing` and `table-cell-link-backlink`.
- **Kept off:** `link-chip-lifecycle` (#6990).

**#6978 (mock):**
- **The mock's `set_todo_state`** now writes a `set_property` on `todo_state`, as the backend does, so undo and redo report a property op and the toast reads "Redid property change".
- **An undo whose `delete_block` (or `restore_block`) found the block already deleted** stamps nothing on the backend, so its redo restores nothing. The mock now marks that reverse `stamped_nothing` and skips the restore.
- **Fixtures:** three backend-authored conformance fixtures pin it.

## Decisions and traps

- **App bugs the bridge's ~40 ms IPC exposed, filed:**
  - #6976: page undo took a second writer inside its transaction; fixed by #6983.
  - #6977: Tab or Backspace during Enter's create; fixed by #6982, so its spec's temporary wait was dropped on rebase.
  - #6990: a Weekly-view day whose page arrives later stays blank. `link-chip-lifecycle` is kept off the list for it.
  - #6997: in page mode, bullet→task could take two Ctrl+Z; fixed on main before this merged.
- **A container restart** killed the slice 12 builder mid-work. A continuation checked every saved mutation against the tree, rebuilt the bridge from clean source, and redid all reds. It also removed a reduced-motion workaround that hid #6990.
- **Test artifacts only, no backend divergence:**
  - one-shot reads of `tags_cache`, which a background rebuild fills, now poll;
  - a duplicate "Exit zoom" button while a zoomed leaf's seeded child is created;
  - counts read before rows render;
  - Escape pressed before a picker opened.

## What ran

- **Bundle on main `245cb0a`** (32 specs, 179 bridge tests):
  - 3× on the bridge: 537/537;
  - 3× on the mock: 534/534;
  - load probe at 6 workers green except the #6997 case, since fixed;
  - `undo-redo-blocks` 10× at 6 workers: 80/80, confirming #6976 is gone;
  - the reviewer's single bridge run: 170/170.
- **Reds:** every new bridge test went red against a Rust or frontend mutation, in history.rs, the property, tag, paste, link and block commands, and the editor serializer and pickers. Each ran in one restore-on-exit command. The #6978 fixtures went red against the old mock handlers.
- **Gates:**
  - `npm run typecheck`, `typecheck:e2e-tauri`;
  - `npx vitest run src/lib/tauri-mock e2e-tauri`;
  - Rust conformance (`cargo nextest -E 'test(conformance)'`);
  - `node --test scripts/e2e-related.test.mjs`;
  - oxlint, oxfmt and `prek run --files`.
