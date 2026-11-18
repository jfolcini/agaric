# Session 4309 — a scroll restore in steps no longer hides the capture button

Found while moving `phone-views` onto the real backend (#6529). Its capture-button test failed 2 runs in 8 on the bridge, and never on the mock. The question was whether the app or the test was at fault. Sampling `#main-content`'s `scrollTop` and the FAB's `data-shown` every 100 ms after Back answered it. On a failing run the restore landed in two steps, 68 px and then 108 px about 100 ms later, as the page's content loaded. The FAB went to hidden at the second step and stayed hidden. On the mock the restore lands in one step.

**Cause:** `useScrolledUp` in `src/components/mobile/QuickCaptureFab.tsx` ignored only the first scroll event of a remount that had no input behind it. A restore's later steps read as a scroll down. A phone user going Back to a scrolled page could lose the capture button without having scrolled.

**Fix:** the FAB remounts per view (`key={viewKey}` in `App.tsx`), so until the user acts in that view, every scroll only records the position. A wheel, touch, key or pointer input still turns the next scroll into a direction.

**Test:** a new `QuickCaptureFab` unit test restores in two steps and expects the FAB still shown, then expects a wheel scroll down to hide it. It was red before the fix.

**Real-backend list:** `phone-views` joins `REAL_BACKEND_SPECS`.

**Ran:**
- the capture-button test on the bridge: 12 of 12, against 2 failures in 8 before the fix;
- all of `phone-views` on the bridge three times (15 passed) and on the mock twice (10 passed);
- the `src/components/mobile` vitest files (60 passed) and typecheck.
