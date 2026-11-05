# Session 3571 — the repeat chip is named by the rule it shows (#5745 S3)

Found while building #6378: the repeat chip shows the formatted rule ("every 1 week") but its `aria-label` was `Repeats +1w`, so a screen reader read the raw syntax. `RepeatIndicator` now passes `formatRepeatLabel` into `block.repeats`, the same string it shows.

- Red first: a new `it.each` in `BlockInlineControls.test.tsx` (`+1w`, `.+3d`, `++monthly`) asserts the label is `block.repeats` of the visible text; all three failed before the fix.
- Three existing assertions pinned the defect (`e2e/page-mode.spec.ts` twice, `PageModeEditor.test.tsx`) and were changed to the shown label with the maintainer's approval, relayed by the coordinator.
- The e2e test at `page-mode.spec.ts:1028` was falsified by reverting the fix: it expected "Repeats every 1 week" and got "Repeats +1w". `e2e-tauri/export-roundtrip.e2e.ts` reads `Repeats weekly`, which is unchanged because `formatRepeatLabel('weekly')` is `weekly`.
- Trap: this container's Playwright wants `chromium_headless_shell-1248`, which is not installed; a throwaway config setting `launchOptions.executablePath: '/opt/pw-browsers/chromium'` runs the mock lane.
- Ran: the editor, page-mode and repeat-utils vitest suites, `npm run typecheck`, and that Playwright test.
