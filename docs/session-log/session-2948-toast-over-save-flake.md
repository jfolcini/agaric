# Session 2948 — a leaving toast took the source editor's Save click

`e2e-tauri/agenda-projected-repeat.e2e.ts` failed on #6133, a PR that changed only jex-import tests: "/repeat .+ counts from today…" died in `seedTasks` with `element click intercepted` on `clickPageSourceButton('Save')`. The same spec passed on the PR before. The maintainer asked for every flake to be fixed rather than re-run.

**Measured on the real lane** (WebKitGTK at 1024×768, throwaway probes, nothing committed from them):
- The toasts sit in the bottom-right column (x 644–1000), and a front toast's top is at y 686. Save is at x 895–960, with its top at y 652 or 689 depending on the page.
- A stack of two toasts, as `/repeat` commands leave behind, puts the back toast at y 678–729.
- When that back toast expires, sonner keeps a hit area larger than the toast while it leaves (`[data-removed='true'][data-front='false']::before`). For about 300 ms, `elementFromPoint` at Save's centre returned the toast.
- A `waitForClickable` that passes just before that moment, followed by a click inside it, is CI's failure. Forcing the back toast's close between the two steps reproduced `element click intercepted` in three runs out of three.

**Fix:** `clickPageSourceButton` first closes every toast from the page, then waits until none is left, exit included. Only then does it wait for the button and click. Waiting for toasts to expire would not do: the save report stays until closed when it lists deletions or warnings.

**Not the cause:** the exit of a lone front toast. In WebKitGTK it slides down, away from Save. A disabled Save is `pointer-events: none`, so the row under it takes the hit test, but Save is enabled from the edit on, with no debounce in between.

**Shown red:** in the forced reproduction, the old sequence failed with `element click intercepted` three times out of three, and the fixed helper saved on the same screen each time.

**Suites:**
- `agenda-projected-repeat.e2e.ts` on the real lane with the fix;
- `npm run typecheck:e2e-tauri`;
- `npx vitest run e2e-tauri` (46 of 46);
- oxlint and oxfmt.
