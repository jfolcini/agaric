# Session 3857 — a view's crash panel stays with that view

#6554, first checkbox: a view that threw during render kept its error panel up in every other
view, relabelled ("Pages encountered an error" became "Tags encountered an error" with the
Pages message), because `ViewDispatcher` returns a `FeatureErrorBoundary` at the same position
for every view and React kept the one instance, `hasError` included.

## What changed

- Every view's boundary in `ViewDispatcher` carries `key={currentView}`, so a view switch
  mounts a fresh boundary. The page editor's boundary is keyed by view too, not by page.
- The page editor's boundary also takes `resetKey={activePage.pageId}` (next section).
- `ViewDispatcher.error-boundary.test.tsx`: Pages throws, rerender with `journal`, the journal
  renders and no `role="alert"` remains. Red on `main` (the journal mock is never found).
- `e2e/view-crash-panel.spec.ts`: a malformed `list_pages_with_metadata` response (`items:
  [null]`, injected by wrapping `__TAURI_INTERNALS__.invoke`, as `integrity-report.spec.ts`
  does) crashes the Pages view; Tags then renders with no panel, and going back to Pages shows
  Pages' own panel again (TanStack serves the cached malformed page, so it does not retry).
  Red on `main` at the Tags assertion.

## Page to page: a reset key, not a page key

Two pages share the page editor's boundary, so a crashed page's panel stayed up on the next
page. The issue prescribed `key={activePage.pageId}`; that was rejected because it remounts
`PageEditor` on every page change, which (1) races in-page find, whose old page's
`setFindContainer(null)` cleanup runs after the new page has registered its container (follow a
link chip, Ctrl+F, "0 of 0"), and (2) adds a `list_all_tags_in_space` call to every link click,
reddening the IPC pin in `e2e/perf.spec.ts` (#5445).

Instead `FeatureErrorBoundary` takes an optional `resetKey` (no library: the repo has none, and
its other boundary, `ErrorBoundary`, has no reset). `getDerivedStateFromProps` stores the key and,
when it changes, clears `hasError` in the same render, so the panel never paints on the new page.
With no error held the change touches only that stored key: the children stay mounted. The
dispatcher passes `resetKey={activePage.pageId}`. Going back to a crashed page renders it again,
like going back to a crashed view; if it still throws, its own panel returns.

## Checks run

- `npx vitest run src/components/common/__tests__ src/components/pages/__tests__
  src/components/__tests__/App.test.tsx`: 55 files, 1458 tests passed.
- Red: the cross-view vitest test with the keys removed fails on the missing journal mock.
- Red, page to page: `FeatureErrorBoundary.test.tsx`'s reset case and the dispatcher's
  page-A-to-page-B case fail without the reset (`child` / `page-editor-PAGE_B` not found); the
  no-remount case fails (mount effect called 2 times) when the children are keyed by `resetKey`;
  the dispatcher case and the e2e page case fail with `resetKey={activePage.pageId}` deleted.
- `e2e/view-crash-panel.spec.ts` page case: an alias that is not a string (`get_page_aliases`
  for Quick Notes returns `[{}]`) crashes Quick Notes' header; header Back renders Getting
  Started with no panel, Forward shows Quick Notes' panel again. Red without the dispatcher's
  `resetKey` at the Getting Started title.
- `npm run typecheck`, `npx oxlint` and `npx oxfmt --check` on the touched paths: exit 0.
- Playwright on PW_PORT 5413, `--workers=1`, unedited apart from `view-crash-panel`:
  `view-crash-panel`, `in-page-find`, `perf` (link-chip pin included), `inner-links`,
  `link-chip-lifecycle`, `navigation-history`: 49 passed, 8 skipped (the `AGARIC_PERF` runs).
