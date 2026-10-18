# Session 2629 — the real-backend property drawer helper waits for the sheet to stop sliding

A flake from #5908: `reserved-property-roundtrip.e2e.ts` failed in CI with the
Block Properties drawer "still existing after 60000ms" after its Close click,
and once with the "Search definitions" input never shown after the "Add
property" click. Both are the first click into the sheet right after it opens.

- **Cause:** `openPropertyDrawer` returned at `waitForDisplayed`, which fires
  partway into the sheet's 150 ms slide-in. The Close button counts as
  clickable once its centre is on screen, before the sheet stops. WebDriver
  aims at the centre it computed, the sheet moves on, and the press lands on
  the sheet's padding: the click does nothing and WebDriver reports no error.
  A mouse-event probe showed `mousedown` on the icon and `mouseup` on the
  sheet content, at the same coordinates.
- **Fix:** the helper waits until the dialog reports no running animations
  (`getAnimations()`). WebdriverIO's `waitForStable` compares two frames and
  falls back to a timer, so it can report a stalled runner's sheet as stable.
  `reserved-property-roundtrip` and `agenda-projected-repeat` are its only
  callers; no other helper opens a sheet.
- **Shown red the way CI failed:** with the slide stretched to 3 s and every
  mousedown advancing it, the old helper reproduced both CI messages at the
  same lines; the new one passed under the same slowdown. Unslowed, the race
  did not fire locally in 58 tries.

Ran: `just e2e-real` for `reserved-property-roundtrip` and
`agenda-projected-repeat`, `tsc -p tsconfig.wdio.json`, `oxlint e2e-tauri`,
`vitest run e2e-tauri` (46).
