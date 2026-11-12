# Session 3951 — the chip contrast spec waits for the view's fade-in

`e2e/token-chip-contrast.spec.ts` failed once in CI (#6627, light theme): no `priority-urgent` chip
among axe's passes, with violations and incomplete both empty.

Cause: `App.tsx` keeps `view-transition-wrapper` at opacity 0 until its fade-in timer fires.
Playwright's `toBeVisible` ignores opacity, so the spec's wait on the page link could pass while the
pane was still transparent. axe then treats every node under the pane as not visible and reports
nothing at all for `color-contrast`: no passes, no violations, no incomplete. Normal runs were saved
only by the time the first injection of axe takes.

Shown by delaying the fade-in timer with an init script: the light themes fail with the CI error
every run. With the wait added, the file passes with and without the delay.

The spec now waits for the wrapper to reach opacity 1, the line other specs already use. No
assertion changed. Not a product defect.

Not audited: other axe specs that open a view and wait only on `toBeVisible`.

Checks run: the spec file; `node --test scripts/e2e-related.test.mjs`.
