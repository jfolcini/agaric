# Session 4334 — leaving page mode no longer logs a read overtaken by block mode

Fix for #6937, found while moving `page-mode.spec.ts` onto the bridge (#6926 slice 7).

**Cause:** page mode's save reads the page again through `read()` in `src/editor/page-mode/PageModeEditor.tsx`. A page store load drops its result when a newer load of the page began (#753), so `read()` saw its rows unchanged and threw `page mode could not read the page`. Switching to Blocks starts block mode's load while the closing save's read is in flight, so the closing save met that case and logged `[ERROR] Page mode save threw`. On the bridge the console gate failed *a page-level Ctrl+Z after leaving page mode…* once in 15 runs; the mock answers at once and never showed it.

**Fix:** when the rows are unchanged but the store is still loading, a newer load overtook this one: `read()` waits for it to finish and returns what it landed. Rows unchanged once nothing is loading still mean the load failed, and throw as before.

**Test:** `PageModeEditor.test.tsx`'s *a reread a newer load overtakes…* now starts the save, releases the newer load while the save waits, and expects the save to end only after it, with nothing logged as an error and the typed text kept in the editor and the backend. It was red before the fix: the save ended before the newer load landed. It replaces the test that pinned the old behaviour (bring nothing in, two loads).

**Ran:** `npx vitest run src/editor/page-mode src/stores` (86 files, 2193 passed); `npm run typecheck`. The page-mode e2e evidence on the bridge comes with slice 7, which lists `page-mode.spec.ts`.
