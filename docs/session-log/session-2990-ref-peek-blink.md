# Session 2990 — The ref peek stops blinking out when its content lands

Set out to fix a red CI run on #6134. `BlockRefPeek.test.tsx` "Preview of Design Notes" found the peek with an empty accessible name. It looked like a flake, but it was a real defect.

**Cause.** `BlockRefPeek`'s placement effect re-runs when the payload lands, so that `flip()` sees the full box. Each run began with `setPosition(null)`, so a peek already showing went `visibility: hidden` until `computePosition` resolved again. It blinked out each time its content arrived, and for that moment it left the accessibility tree. The test caught the moment.

**Fix.** A placement now carries the anchor rect it was computed for (`Placement`, `placementFor`). A placement for another anchor counts as none:
- moving to another chip still hides the peek until it is placed;
- a re-place for the same anchor keeps the peek visible.

The anchor only changes through `open()`, which always takes a fresh `getBoundingClientRect()`. So the check by reference errs towards hiding, never towards showing a stale box.

**Tests:**
- **vitest:** a shown peek stays visible, with its accessible name, while its blocks land. Red against the old code: `toBeVisible` saw `visibility: hidden`.
- **Playwright (`e2e/page-link-preview.spec.ts`):** a MutationObserver records the peek's `style.visibility` at every DOM change, which is before any paint, so the mock lane can see a one-frame blink. Red against the old code: `["", "hidden", ""]`. Green with `--repeat-each=15`.
- The backend plays no part, so there is no `e2e-tauri` spec.

**Suites:**
- vitest on the peek component, hook and `block-ref` (67 tests);
- typecheck and lint;
- Playwright over the page-link preview, block-ref peek keyboard and related specs (8 passed).
