# Session 3857 — a view's crash panel stays with that view

#6554, first checkbox: a view that threw during render kept its error panel up in every other
view, relabelled ("Pages encountered an error" became "Tags encountered an error" with the
Pages message), because `ViewDispatcher` returns a `FeatureErrorBoundary` at the same position
for every view and React kept the one instance, `hasError` included.

## What changed

- Every view's boundary in `ViewDispatcher` carries `key={currentView}`, so a view switch
  mounts a fresh boundary. The page editor's boundary is keyed by view too, not by page.
- `ViewDispatcher.error-boundary.test.tsx`: Pages throws, rerender with `journal`, the journal
  renders and no `role="alert"` remains. Red on `main` (the journal mock is never found).
- `e2e/view-crash-panel.spec.ts`: a malformed `list_pages_with_metadata` response (`items:
  [null]`, injected by wrapping `__TAURI_INTERNALS__.invoke`, as `integrity-report.spec.ts`
  does) crashes the Pages view; Tags then renders with no panel, and going back to Pages shows
  Pages' own panel again (TanStack serves the cached malformed page, so it does not retry).
  Red on `main` at the Tags assertion.

## Page to page: not done, and why

The issue prescribes `key={activePage.pageId}` on the page editor's boundary. That remounts
`PageEditor` on every page change, which costs two things:

1. In-page find breaks on the new page. `PageEditor`'s `useEffect` cleanup
   `setFindContainer(null)` runs in the passive flush after the next page's ref callback has
   registered its container. Reproduced: follow a link chip, Ctrl+F, "0 of 0". Deleting that
   effect fixes it (the ref callback already unregisters, before the next page's ref attaches).
2. `e2e/perf.spec.ts` "opening a page and following a link chip pin their IPC (#5445)" goes
   red: a link click now also sends `list_all_tags_in_space`, because the header that loads it
   once per mount no longer stays mounted. Fixing that means editing an existing e2e pin.

That part is left for a maintainer decision.

## Checks run

- `npx vitest run src/components/pages/__tests__/`: 34 files, 965 tests passed.
- Red: the new vitest test with the keys removed fails on the missing journal mock.
- `npm run typecheck`, `npx oxlint` on the touched paths: exit 0.
- Playwright on PW_PORT 5413, `--workers=1`: `view-crash-panel`, `in-page-find`, `inner-links`
  and perf's link-chip pin, 30 passed; the new spec red on `main`'s dispatcher.
