# Session 2490 — Page mode shows and sets tasks

Slice 2 of #5743, after slice 1's typed tags (#5777). A page whose blocks hold a
task state now opens in page mode.

**Design.**
- `pageBlock` has a plain DOM node view when page mode is given a task source
  (`src/editor/page-mode/page-tasks.ts`). It wraps the block's content in
  `.page-block-content`. A non-editable `.page-block-controls` holds block
  mode's own `BlockInlineControls`, mounted through TipTap's `ReactRenderer`
  only while the block has a state. The controls sit in the left slot page mode
  already kept for them, at the same pixel as block mode's checkbox.
- The state is not a node attribute. It is read by id from the page store
  (`blocksById`), which each node view subscribes to. An attribute would follow
  the node and not the id: Enter at a task's start would leave the checkbox on
  the new empty block. Only a store change redraws a checkbox, so typing never
  does. A peer's change arrives with the store's reload, outside the document
  and its undo history.
- The click and `cycleTaskState` (Ctrl+Enter, a plugin at priority 1000, ahead
  of the hard break's Mod-Enter) go through `handleToggleTodo`
  (`useBlockProperties`), queued on page mode's save chain after a save. A new
  empty block is created for it first (`PageSaveState.keep`).
- A marker left as text is folded where slice 1 commits tags: in the blocks the
  caret changed and left, now every block a transaction changed
  (`changedBlocks`), so a multi-line paste counts too. `commitPageTask` reads
  the marker from the saved node: `processCheckboxSyntax`, or the bare `[ ] `
  block mode's input rule also takes. It then commits through
  `commitCheckboxState`. The tag commit runs after it, on the text it wrote.
- Only a marker the edit typed is folded, as block mode's `classifyUnmountFlush`
  requires: each changed block is recorded as it was before its first change
  (`transaction.before`), and a block that already started with a marker, such
  as `[x] means unknown`, keeps it as text (review of #5805).
- `TODO` stays a word, as the editor docs say block mode keeps it. The brief
  asked for the keyword, but block mode does not convert it, so neither does
  page mode.
- `TaskPaste` is not added. In page mode it would hide the marker, with nothing
  drawn until the caret leaves. Pasted lines reach the same fold as typed ones.
- The `tasks` blocker and `pageMode.blocked.tasks` are gone. The properties
  blocker ignores `SYSTEM_MANAGED_PROPERTY_KEYS`. The todo-state command writes
  `created_at` on every task and `completed_at` on DONE, so without this every
  real task page stayed blocked under the properties kind.
- Closed tasks are struck through and use `text-muted-foreground`. Block mode
  uses `opacity-50`, which measures 3.4:1. axe flags that in page mode and
  reports block mode's copy as incomplete.

**Tests, each red first at the predicted assertion:**
- vitest `PageModeEditor.test.tsx`: checkbox and axe, click through the command
  and its refusal, Ctrl+Enter on a block and on a new empty one, a typed `[ ] `
  converting only on leave, `- [x] ` giving DONE with `TODO` left as text,
  pasted lines, a refused marker staying text, a peer's change, and no redraw on
  typing.
- `page-mode-fit.test.ts`: a page of tasks in, a task with a priority or a date
  out, and the stamps ignored.
- The fast-check property gained marker-then-leave and cycle steps. The backend
  holds each block's last given state and no other. The marker leaves the text.
- Playwright `page-mode.spec.ts`: click, Ctrl+Enter and a typed marker, then
  away and back, then axe. It passed 30 of 30 at 8 workers. ArrowDown pressed in
  the frame the last key was drawn was lost natively, without the checkbox too
  (2 of 8). The spec now waits a frame, as the typed-tag spec does.
  `page-mode-setting.spec.ts` now blocks on a priority.
- e2e-tauri `page-mode-tasks.e2e.ts`: a typed marker, a click, a round trip and
  the Agenda list, which reads `blocks.todo_state`. Undated tasks never reach
  `agenda_cache`. This spec is type-checked only; it runs in CI. Its first CI run
  failed at the round trip: the page reopened in blocks, because the switch
  changes the page on screen only and the setting was Blocks, with Page still
  offered. The spec now chooses Page again after reopening.

**Measurement.** `AGARIC_PERF=1 e2e/perf.spec.ts -g 'page mode'` now seeds every
block as a task, TODO and DONE in turn. With the run's sizes held to 500 and 5
repeats, unthrottled, median and band:

| Measure | Block mode | Page mode, tasks | Page mode, no tasks |
| --- | --- | --- | --- |
| Open | 48 [45–70] ms | 367 [349–383] ms | 359 [343–362] ms |
| Worst frame while opening | 68 [53–127] ms | 193 [176–217] ms | 55 [0–70] ms |
| Key to paint, p50 | 2.8 [2.8–3.1] ms | 5.6 [5.5–5.9] ms | 4.4 [4.3–4.6] ms |
| Key to paint, p95 | 4.5 [3.2–12] ms | 7.3 [6.5–8.7] ms | 5.7 [5.4–6.7] ms |

Typing in page mode with tasks makes 2–3 React commits per 30 keys, the same as
without tasks, and has no long frames. The 500 checkboxes mounting at once cost
the open's long frame. Mounting them per viewport is the lever, if the cap is
raised.

**Gates:** vitest over `src/editor src/stores src/components/pages`,
`npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint`, and the
page-mode, page-mode-setting and perf Playwright specs.
