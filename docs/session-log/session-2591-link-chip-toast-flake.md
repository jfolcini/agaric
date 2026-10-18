# Session 2591 — link-chip spec: Undo on the toast the step raised

**Flake:** `e2e/link-chip-lifecycle.spec.ts`, "a broken chip removes itself
when clicked (#5736) › from a static block", red on #5866, #5867, #5869
and #5871 and once on main: the toast's Undo was "not stable", then the
front toast intercepted the click, then the button detached.

**Cause:** sonner 2.0.8 prepends each toast (`[toast, ...toasts]`, the
newest is `data-index="0"`, `data-front="true"`), and `notify.success`
keeps sonner's default 4 s. The test removes the chip twice, so the first
removal's toast is still alive at the second; `removedToast` took
`.last()`, the oldest, stacked behind the front one. A probe before the
Undo click on the old code: two matching toasts live in 5 of 6 runs,
`.last()` on `data-index="2"`, and those 5 failed with CI's call log. On a
pass it could press Undo on the wrong removal.

**Fix:** `removedToast` matches `[data-sonner-toast][data-front="true"]`
with the text, so it addresses the toast the step just raised. No wait,
retry or timeout. 160/160 with `--repeat-each=20 --workers=4`; 80/80 under
4× CPU throttling, with two matching toasts live in every run and the
locator on `data-index="0"`.

**The same file's other flake** (CI run 39057639127, "a ((block)) chip
shows the target block's edited text (#5245)"): the chip kept the original
text, so the `End` then `Shift+Home` selection never took; e2e/AGENTS.md
§ Flakes names that race (ProseMirror reads a native caret move only on a
late `selectionchange`). It now uses `replaceEditorText`, which selects
through ProseMirror. Not reproduced locally in 100 throttled runs.

**Checked, no change:** every other `[data-sonner-toast]` lookup in `e2e/`
and `e2e-tauri/` raises a given text at most once per test.
