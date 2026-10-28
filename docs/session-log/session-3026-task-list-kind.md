# Session 3026 — A task is a third list kind, beside bulleted and numbered (#5691)

Set out to build T, the maintainer's D3: a task, a bulleted block and a numbered block are three mutually exclusive list kinds, in block mode and page mode.

**Shipped:**
- **Display.** A block with a task state shows its checkbox and no bullet or number, whatever `listStyle` it stores (`shownListStyle`). This covers:
  - the static block and the roving editor's marker;
  - page mode (`PageLists.shownStyleOf`);
  - the Edit as Markdown preview.
  Existing blocks that store both show as tasks, and their stored style stays. A task breaks a numbered run, as a plain block does.
- **Exclusive on write.** Picking one kind clears the other. The picked kind is written first; the other is cleared only after that write succeeds, so a refused write leaves the block as it was. One helper per direction: `clearListStyles` (`list-style.ts`) and `clearTaskStates` (`page-blocks.ts`).
  - **Task to list:** the toolbar's list buttons, `/bullet-list`, `/numbered-list`, Turn into (toolbar, block menu, slash) and the page toolbar.
  - **List to task:** the task button, `Ctrl+Enter`, the `/todo` family, the batch toolbar and the block menu.
  - **Typed markers:** `- ` or `1. ` typed on a task, and `[ ] ` typed on a list block, in both modes.
- **Cycling** a task back to no state brings no list style back.

**Decisions and traps:**
- **Reading the task state costs one `get_batch_properties`,** and only when a block goes from no state to a task. The `BatchPropertiesProvider` sits below the hooks and holds only windowed ids, so it cannot answer.
- **`clearTaskStates` moved to the page store,** because hooks may not import components (#3121).
- **Review found a legacy gap.** A task that already stores `bullet` ignored a typed `- ` in page mode, because of an early return on "same style". That return now also requires the style to show.
- **#6161's ordinals rule and this one combine:** an unmarked block and a task both break a numbered run.
- **Undo of the paired writes is #6156,** which the maintainer decided tonight: one step. Its call sites are listed for that PR.

**Tests:**
- vitest for each helper and routing path, including the refused-first-write cases;
- `e2e/task-list-kind.spec.ts` in block mode and page mode, with persistence checked after navigating away and back.
- Existing tests gained only setup: a `get_batch_properties` stub, the new `pageStore` argument, and three IPC counts raised by the one read.
- Every behaviour was shown red: six by the builder, eleven in the first review, and three re-run in the second.

**Suites:**
- vitest over the block-tree, editor, stores, hooks, lib and page-mode dirs (12,913 tests);
- typecheck, lint and the manual-stage hooks;
- Playwright: `task-list-kind`, `checkbox-typing`, `list-style-keyboard`, `list-marker-only-lists`, `page-mode-toolbar`, `page-mode`, `nested-list-blur-1513`, `slash-commands-happy-paths` and the batch, slash and task specs.
