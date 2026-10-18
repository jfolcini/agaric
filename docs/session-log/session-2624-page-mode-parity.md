# Session 2624 — one edit through both modes' save paths lands the same backend state

Two #5743 testing items.

- **Parity:** `page-mode-parity.test.ts` makes one edit to an empty block in each mode and then leaves it.
  - Block mode runs `runUnmountFlush` over a real page-block store.
  - Page mode runs `savePage`, then `commitPageTyped`.

  It reads back the block's text, `todo_state`, properties and tags. Both modes must agree, and block mode is pinned to exact values so two no-ops can't pass. The edits are a `#name`, a `key:: value` line, a pasted `- [ ] ` marker, `TODO` as a word, and all three together.
- **The order page mode commits a block in** (task marker, then property lines, then tags) moved out of `PageModeEditor.tsx`'s closure into `commitPageTyped` in `page-tags.ts`. The test now drives the editor's own sequence.
- **Mutation scope:** `stryker.modules.mjs` adds `page-mode-fit`, `page-properties` and `page-tags`.
  - `page-mode-fit` reaches 100%, `page-tags` 18/19 and `page-properties` 33 killed with 6 timed out.
  - The new tests in `page-mode-fit.test.ts`, `page-mode-parity.test.ts` and `page-properties.test.ts` killed the survivors.
  - The survivors left are equivalent and are recorded in those files.
  - `page-tasks` (502 mutants, through the whole editor suite) had not finished after 590 s. It and the other node-view modules (`page-lists`, `page-rendered` and `page-attachments`) go on the file's measured-but-deferred list rather than into the weekly lane, which has a 60-minute timeout.

Shown red at the parity assertion: page mode's `key::` parse broken, the task commit skipped, and the tag commit skipped, each failing its own cases.

Ran: `vitest run src/editor/page-mode` (248) and `PageEditor.test.tsx`; `npm run typecheck`; oxlint and oxfmt on the changed files.
