# Session 1887 — the weekly drag-reschedule updates the due chip in place (#5288)

This is the next batch of the session that logged 1873, 1882 and 1884.
#5308 merged once `validate-all` and `dco` passed and the reviewer had
approved; its review had no notes.

## #5288

- **The bug.** In the Journal's weekly view, dragging a task onto another
  day toasted "Task rescheduled to …". The task's due chip kept the old
  date until the mode or week changed.
  - The chip reads `due_date` from the page store.
  - `useBlockReschedule.reschedule` only called the raw `setDueDate` /
    `setScheduledDate`.
  - The `block:properties-changed` targets only bump invalidation
    counters, so nothing wrote the date back into a mounted store.
- **Why the e2e missed it.** `weekly-reschedule-drag.spec.ts` switched to
  Daily and back before asserting, which remounted the tree and refetched
  the row.
- **The fix.** After the setter resolves, `reschedule` patches the written
  field into every mounted page store that owns the block. It finds them
  with `forEachPageStore` and `storeOwnsBlock`, and uses the same
  `setState` map the date picker and the property drawer already use.
  - A rejection leaves the stores untouched.
  - Same-page stores elsewhere (an embed) follow through the existing
    `mirrorToSiblings`.
  - The two other date writers, `BlockPropertyDrawer` and `DateChipEditor`,
    already patch or refresh their own state, so nothing is patched twice.
  - Rescheduling from an agenda list chip now also updates that page's
    chip when the page is open.
- **The e2e** now asserts the chip without leaving weekly view. The reviewer
  removed an added `toBeVisible()` and its comment. The comment claimed a
  negated `toHaveText` passes when the element is gone. In Playwright 1.63
  it does not: `not.toHaveText` keeps polling and fails with "element(s)
  not found". The `toBeVisible()` ran before the drop, so it guarded nothing.
- **Older gap, left as is.** `reschedule` has never registered a page undo
  entry, unlike the date picker. This change does not touch that.

## Verified

- **Falsification.** Four mutations were run against a backed-up copy, then
  restored and checked with `cmp`. Each new vitest test and the e2e went red
  at least once:
  - removing the patch;
  - dropping the ownership gate;
  - patching before the setter resolves;
  - writing `null` instead of the date.
- **Full vitest (reviewer, four shards):** 866 files and 20,413 tests passed
  (51 skipped, 1 expected fail). `npm run typecheck` exits 0.
- **Playwright against the mock backend:** 60 passed and 2 skipped (both
  existing `test.skip`). The specs were:
  - `weekly-reschedule-drag`
  - `journal-panels`
  - `slash-command-properties`
  - `toolbar-controls`
  - `agenda-advanced`
  - `due-panel-keyboard-jumps`
