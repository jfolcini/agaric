# Session 2852 — the page-mode first-switch spec reads the place the switch carries

`e2e/page-mode.spec.ts` › "the first switch of a session … keeps the place" failed in CI on #6062's run 39748200760. It expected the block at the top at -18 px and got -6. It had passed 10 of 10 runs locally under load earlier (session 2847's notes).

**Cause.** The test read the top block right after scrolling block 60 into view, before block mode's rows near the new position had hydrated:
- **Placeholders.** The placeholders are 28 px estimates (`SortableBlockWrapper`'s placeholder branch). They grow to 32 px rows four per frame (`HYDRATION_ROWS_PER_FRAME`, `useViewportObserver`).
- **The shift.** Rows 56–58 grew 4 px each with no scroll anchoring, which moved block 59 from -18 to -6 after the test's read and before its keypress.
- **Page mode was right.** It reads the place synchronously on the keydown (`scrollPlace()` in `use-page-mode.ts`) and restores it exactly, so it carried -6.

The test compared that against its stale -18. Nothing else ran between the scroll and the read in this test, so a slow runner exposed it.

**Fix: test only.**
- A capture-phase `keydown` listener on `window` (`topBlockOnKey`) records the place as the switch's key arrives, before the app reads it, so the test compares against the place the switch actually carries.
- The id check now runs on that record, so a listener that never fired fails rather than passing.
- No tolerance was widened. Page mode needs no change.

**Shown red and green.** The red run used the spec as it was on main, with `IntersectionObserver` callbacks delayed 100 ms so hydration lands after the read, as on a slow runner: 10 of 10 red, with CI's exact -18 / -6. Under the same conditions the fixed spec was green 10 of 10. Adding 12 px to `restoreScrollPlace` turned the fixed test red on its `toEqual`. 4× CPU throttling alone did not reproduce it.

**Suites run:** the whole `page-mode.spec.ts` with two workers (39 passed), the target test 10× with two workers, vitest over `src/editor/page-mode` (694 passed), typecheck, oxlint, and oxfmt.
