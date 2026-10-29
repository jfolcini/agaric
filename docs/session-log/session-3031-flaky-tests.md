# Session 3031 — Flaky tests from fourteen days of CI: toasts over clicks, a jumping journal editor, a pairing that stops its dependents, a peek's name

The maintainer asked for every flaky and slow test to be fixed. A discovery pass read fourteen days of CI: 1,833 first attempts, and every job that failed and then passed on the same commit. It produced a ranked list (F1–F13). This PR carries the fixes that needed code. `editorIn` and the header-callback race (F12) shipped first, in #6165.

**Fixed:**
- **F1, a toast intercepts a click** (8 real-backend failures). `clickUncovered` (`e2e-tauri/helpers.ts`) closes toasts, then hit-tests the element's centre and clicks it in one `browser.execute`, so nothing can arrive between the check and the click. A timeout names what covers the element.
  - It is used by `clickPageSourceButton`, the "Edit as Markdown" menu item, "Add alias" and "Delete page".
  - Reproduced with a fake toast placed over Save between the wait and the click: `element click intercepted`, from the same test and stack as CI.
- **F3, `markdown-reveal-persist` line 174** (2 failures today). The cause was not the suspected one.
  - After "Add block", the day's list remounts, and the new, already focused editor jumps 152 px for about 50 ms.
  - The helper's final click used a centre taken mid-jump. It landed below the editor and blurred it, and the empty-block cleanup then dropped the block.
  - `openJournalBlockEditor` now waits for the editor's focus instead of clicking. Every path already ends focused.
- **F2, `sync-two-device`.** The tests after pairing share a `before` hook, so a failed pairing stops them at once instead of each timing out. This mocha version still counts each as failed.
  - The 10-24 unpair failure needs a Rust change in the sync peer harness, queued for the Rust lane.
- **F10, `BlockRefPeek`.** The peek stays hidden, and so unnamed, until its placement lands, and arriving blocks re-place it. The accessible-name check now waits. Reproduced with a 30 ms delay on the placement.

**Already fixed on main, so no change:**
- F4, the Alt+Enter link spec: #6082.
- F7, the reminder spec's midnight refusal: #5952.
- F8, the announcer's teardown: #5664.
Each was confirmed by reproducing it against the code before its fix.

**Following convention:** F11, `page-mode.property`. The repo leaves property tests unseeded on purpose and pins shrunk counterexamples (`src/__tests__/AGENTS.md`); CI's seed passes.

**Not reproduced, left as they are:**
- F6, `history-revert`;
- F9, `property-types`.
Their CI snapshots show a popover closed by focus moving away, not the suspected re-render or reload. No pressure reproduced them: CPU throttling, IPC delays, stretched timers, delayed chunks. They need another look.

**Suites:**
- every changed real-backend spec passed 3 of 3;
- all 30 other specs using the changed helpers passed once;
- the reviewer re-ran the F1 red and the five specs;
- `BlockRefPeek` passed 20 of 20;
- typecheck for `e2e-tauri`, lint, and vitest on `e2e-tauri`.
