# Session 1056 — #1263: decompose PageBrowser.tsx (behavior-preserving)

2026-06-16. From the 2026-06 Opus quality audit (maintainability). `/loop /batch-issues` run.
(Followed #1264, which first removed the dead densityV1 path from the same file.)

## Change (pure refactor — zero behavior change)
`PageBrowser.tsx` was a 1230-line container with ~62 hook calls. Extracted 6 cohesive
hooks under `src/hooks/`, leaving the container a thin orchestrator (**653 LOC, 14 hook
calls** — −47% / −77%):
- `usePageBrowserData` — query/cursor-recovery/`displayTotalCount`/delete-interceptor.
- `usePageBrowserFilters` (+ a split-out `useFilterAnnouncementSettle`) — compound filters,
  tag/alias resolution, free-text, add/remove/clear announcements. The settle effect is
  split out so it still runs *after* grouping (reading post-grouping `matchedPageCount`),
  preserving the announce-prefix → settle ordering.
- `usePageCreation` — optimistic-prepend vs reload, conflict toast, focus timer.
- `usePageBrowserScrollRestoration`, `usePageBrowserAutoLoad`, `usePageBrowserKeyboard`.

Every extraction is a verbatim move (same effect bodies, deps, and timing; live values
passed as params — no stale capture). The only non-mechanical touch: one stable `useState`
setter added to a deps list (no extra churn); all `exhaustive-deps` disables carried over.

## Verification
The existing `PageBrowser*.test.tsx` behavior-oracle suites pass **unchanged** (no
import-path edits needed) — strong behavior-preservation evidence. Added focused unit tests
for `usePageBrowserData` + `usePageCreation`. Reviewer reconstructed the full effect order
old-vs-new and confirmed the announce/settle ordering + closure capture. Full frontend suite
12767 passed; tsc + oxlint clean (PageBrowser complexity reduced 29→27).
