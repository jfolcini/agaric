# Session 1055 — #1264: remove dead densityV1 rollback flag + legacy listBlocks/PageRow path

2026-06-16. From the 2026-06 Opus quality audit (maintainability). `/loop /batch-issues` run.

## Finding
The `pageBrowser.densityV1` rollback flag was read once at mount, defaulted ON
(`localStorage.getItem(...) !== 'false'`), and had **no user-facing toggle** — only
test/e2e code ever set it to `'false'`. So the legacy code path it gated (a `listBlocks`
query + a ~120-line legacy `PageRow` leaf renderer) was dead in production.

## Fix
Removed the flag (`DENSITY_V1_FLAG_KEY`, `usePageBrowserDensityV1Flag`), collapsed the
`queryFn` fork to the sole `listPagesWithMetadata` path, removed the `flagOn` prop + the
legacy `PageRow` component + its now-unused imports (`HighlightMatch`/`Trash2`/`Checkbox`/
`Button`). The shared `listBlocks` IPC wrapper is **preserved** — 15 other callers still use
it; only PageBrowser's import + branch were removed.

## Verification
Tests that pinned `densityV1='false'` were rewritten to assert the live metadata path (not
deleted); the dead-path-only tests were removed. Reviewer confirmed the flag was
production-dead, `listBlocks` preserved, no dangling refs (`grep densityV1/flagOn` clean
except the generated bindings comment), and faithful test migration. Full frontend suite
12756 passed; tsc + oxlint clean (the one complexity warning on PageBrowser is pre-existing
— this change reduced it 30→29).
