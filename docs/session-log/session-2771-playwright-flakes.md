# Session 2771 — the page-mode drawer Escape flake, and a sweep of a week of CI reds

The maintainer said "fix flakes". Playwright runs with `retries: 0`, so I read every CI run since 2026-10-12 that was re-run (attempt 1's failed jobs) and every failed `main` push, and sorted each red into a flake, a real regression, or infra.

Still open on `main`, and fixed here:

- `page-mode.spec.ts` › "the slash menu sets a task …": `not.toBeFocused()` timed out after the second Escape (run 39240296683, attempt 1 red, attempt 2 green on the same commit). Clicking *Clear due date* leaves the focus on `body`; the Escape that closes the drawer runs with nothing focused, and the focus comes back to the editor a task later, from Radix FocusScope's unmount `setTimeout` and `propertiesEdited`'s own timer. An in-page log showed that gap at about 10 ms, and the next Escape landing about 8 ms after the focus came back. On a loaded runner the Escape arrives first, goes to `body`, and the focus then lands in the editor and stays there. The spec now waits for `toBeFocused()` before that Escape. That is the state the step needs, and it also pins that the drawer gives the focus back. It did not fail in 30 normal runs or 16 at 6× CPU throttle, because throttling slows every task alike. Delaying the page's zero-delay timers by 100 ms after the drawer's Escape reproduced the CI error exactly: 2 of 2 red before the fix, 12 of 12 green after. 30 of 30 normal runs and the whole spec (31 tests) were green after the fix.

Already fixed on `main` before this session (the cause is in the named commit):

- `spaces-management` switcher click and `pages-view` sort Escape: a tooltip over an open Select took the click or the Escape (9a63e2ac1, #5908).
- `link-chip-lifecycle` broken-chip Undo: #5876, #5880. `diagram-legibility` wide equation: #5856. `keyboard-collisions` Ctrl+B: #5536. `graph-view` zoom hairline: #5704. `page-alias-add`: #5764. `week-cross-day-clipboard`: #5606.
- `page-mode` "#name … becomes the tag", "priorities and dates", "arrows move the cursor": `caret()` now waits out ProseMirror's post-focus selection check (a3f3de603, #5836).
- vitest: `page-mode.property` (#5831, #5840), `QrScanner` (#5840), `PageSourceEditor` ULID warning (#5705), the announcer timer firing after teardown (#5664).

Not flakes: `phone-views.spec.ts:112` (fixed by #5982) and `phone-content-edge` (#5955 and #5958 crossed; fixed by d152c3f1b) were regressions on `main`. `phone-view-headers` Trash and `settings-phone` were branch work in progress, and `query-hint` was a branch regression. Two `webServer` start failures were infra.

Unexplained: `link-chip-lifecycle` "a ((block)) chip shows the target block's edited text" was red once, on a PR branch (run 39057639127): the chip kept the old title. It passed 140 of 140 runs here (40 at 4 workers, 100 at 8), and the artifact holds no trace, so it was not changed.

Suites run: the fixed test 30× at 4 workers before and after, the timer-delay falsification, all of `page-mode.spec.ts`, `npx oxlint src e2e`, `npm run typecheck`, and `node --test scripts/e2e-related.test.mjs`.
