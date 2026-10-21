# Session 2835 — page mode's save triggers are tested

One finding of #5691's 2026-10-21 review: blur, `visibilitychange` and `pagehide` as save triggers were untested. Making any of them a no-op passed every test, and WebKitGTK, the desktop runtime, may send only `pagehide` as the window closes. Escape was asserted only to blur, never to save.

- **Premise.** Each trigger was made a no-op in turn, one restoring command per mutation. `src/editor/page-mode` vitest stayed green under all three. The six page-mode Playwright specs stayed green under the blur no-op, because the Escape case's backend poll is also met by the 700 ms idle save. `page-mode.spec.ts` stayed green under the hidden and pagehide no-ops; no spec dispatches either event.
- **The hidden test could not fail.** It typed into the second block while the first held pending text, so the caret leaving the first block saved it, and the `hidden` event had nothing to do. It now types in the caret's block. A `visible` event leaves the backend unchanged, and a `hidden` event then saves.
- **New tests.** "saves pending text when the window closes (`pagehide`)" covers that trigger. "saves pending text when Escape leaves the text, and when the focus goes elsewhere" covers Escape and blur. Each fires its trigger, waits one task (well before the idle save), and reads the mock backend.

Shown red:
- the hidden save made a no-op, and the hidden-only condition removed;
- `pagehide` made a no-op (re-run by the orchestrator: `expected 'first' to be 'first!'`);
- blur made a no-op;
- `leaveText` no longer moving the focus;
- blur saving only when the focus goes to the surface.

Tests only; no production change. Suites run: `src/editor/page-mode` vitest (683 passed), typecheck, lint.
