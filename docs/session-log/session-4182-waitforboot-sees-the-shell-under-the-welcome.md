# Session 4182 — e2e: waitForBoot sees the shell under the first-run welcome

Set out to find why `e2e/first-run-import-pairing.spec.ts` ("Import notes closes the welcome…") timed out in `waitForBoot` once in `validate / playwright (3)` on #6779, a PR that does not touch boot.

## What it was

A test race in the helper, not a product bug. The failed run's `error-context.md` shows the app booted: the page holds the "Welcome to Agaric" dialog and nothing else. The dialog is modal, so Radix marks the shell `aria-hidden`, and `waitForBoot`'s desktop signal was `getByRole('button', { name: 'Journal' })`, which skips `aria-hidden` elements. `WelcomeModal` is a lazy chunk, so the helper passed only when one of its polls landed between the shell's first paint and the chunk's arrival. On a loaded runner `goto` returned after the dialog had opened and the locator matched nothing for the whole timeout.

The lead in the brief was wrong: #6778's boot retry fires only on Tauri's "state not managed" refusal, which the mock never returns; #6780 leaves `waitForBoot` and the welcome gate alone, and #6786 changes `openUrl` only. The race dates from #6609, which added the first desktop spec that boots on empty storage; `onboarding-first-run.spec.ts` runs on a phone, where the signal is a test id that `aria-hidden` does not affect.

## What shipped

- `waitForBoot` finds the Journal button with `includeHidden: true`. `toBeVisible` still requires it to be rendered; only the accessibility-tree filter is gone.
- A test in `first-run-import-pairing.spec.ts` that holds the page's load event until the welcome is visible, then calls `waitForBoot`: the losing order, every time.

## Suites run

`e2e/first-run-import-pairing.spec.ts` and `e2e/onboarding-first-run.spec.ts`, green. The new test without the fix fails with the CI run's error (`element(s) not found` on the same locator, 15 s); with `includeHidden` removed again by one mutation it went red the same way. `npm run typecheck:e2e`. Not run: the rest of Playwright (every spec boots through this helper); CI's run is the check.
