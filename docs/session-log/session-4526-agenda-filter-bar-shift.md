# Session 4526 — the agenda's rows no longer jump when its filter bar loads

CI on main went red on `touch-reachable-info.spec.ts` (run 45879793981, d0d80b3): tapping a blocked task's indicator on a phone opened no popover. It passed locally three times in a row. The trace showed why. The tap landed at the indicator's place, then the list moved down 43 px, so it hit the "Projects" group heading instead.

**Cause.** `AgendaFilterBuilder` is lazy (#5441) behind a Suspense fallback one row tall. On a phone the loaded bar wraps to two rows: the default status chip and Clear all, then Add filter. The rows rendered from the query before the chunk arrived, and the bar then pushed them down. The trace's last snapshot before the tap still has the one-row fallback, and Add filter appears during the tap. A person who taps a row right after opening Agenda hits the row above it the same way.

**Fix.** One Suspense boundary now wraps the whole view, so the rows paint together with the bar. The fallback is the same three-row skeleton `AgendaResults` shows while its query loads. The chunk stays lazy, off every other journal mode's boot path.

**Tests**

- New `AgendaView.filter-chunk.test.tsx` holds the builder's chunk back until the query has answered and asserts the rows are not painted yet. It was red against main's `AgendaView.tsx` at that assertion.
- vitest on every file that renders `AgendaView` or `JournalPage`: 12 files, 432 tests, all passed.
- `npm run typecheck`, `oxlint` and `oxfmt --check`: clean.
- Playwright on the mock: `touch-reachable-info`, `agenda-filter-builder`, `agenda-sort-group`, `agenda-advanced`, `journal-mode-tabs` and `phone-views` all pass. `just e2e-related` picks most of the lane, so CI's run is the check.
