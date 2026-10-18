# Session 2653 — the integrity check offers Report a bug when it finds a divergence

The maintainer asked, after a 0.19 health check found two divergences, for a
way to report them straight from the result.

- **Button:** Settings › App health › Integrity check shows *Report a bug*
  beside *Copy for a bug report* whenever the check finds at least one
  divergence; a clean result or a failed run shows none.
- **Reuse:** it dispatches the same event the crash screen's button uses
  (`dispatchBugReport({ message, integrityReport })`), and the App-level
  `BugReportDialog` already folds an integrity report into its preview and the
  GitHub issue fields (#5360). No dialog code changed. The title reads
  "Integrity check: N divergences"; the description is left for the user.

Tests: vitest opens the dialog from a divergent result and checks the title
and preview, checks a clean or failed result has no button, and runs axe with
the button shown. A mock-lane test in `e2e/settings.spec.ts` swaps in a
two-divergence result for one call (the mock always matches) and reports it.
Each was red with the report left out, the title emptied, or the divergence
test inverted.

Ran: vitest over `src/components/settings`, `src/components/dialogs` and
`src/lib/i18n` (897), the integrity e2e tests, `npm run typecheck`,
`oxlint src`.
