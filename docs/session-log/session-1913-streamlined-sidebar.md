# Session 1913 — streamlined sidebar (#5269)

This builds the approved plan #5269: the sidebar keeps the daily surfaces,
page-adjacent views move behind buttons in the Pages header, and system
screens move into Settings. Three builders split the work: sidebar and
Settings, the Pages header row, then e2e and docs. A reviewer took
screenshots of every changed surface.

## What shipped

- **Sidebar.**
  - Header: logo, collapse toggle, space switcher, New Page.
  - Nav: Journal, Pages, Search, Tags; Bookmarks are unchanged.
  - Footer: one Sync row (button, status dot, last-synced line) and
    Settings.
  - On mobile the Sheet drops to about half its height, so Bookmarks show
    without scrolling.
- **Pages header.** Icon buttons for Tags, Graph, Query, Templates and
  Trash, built from `NAV_ITEMS`. Trash carries the count badge.
  `useTrashCount` moved to `src/hooks/`, which broke an import cycle
  through `ViewDispatcher`.
- **Settings.** Status is a tab in Data & Sync, and the `status` view id is
  retired: a persisted one falls back to the journal. The Data tab has an
  Edit history card that opens History.
- **Palette.** `toggle-theme` uses the module-level `cycleThemePreference`,
  so the hook's unused `toggleTheme` is gone. `go-status` lands on
  Settings › Status.
- **e2e.** `navigateToView()` routes Graph, Query, Templates and Trash
  through the Pages header, Status through its Settings tab, and History
  through Settings › Data. About 15 specs follow.
  - The review found that `scripts/android-e2e-safe-area.mjs` recognised
    the drawer by its Trash, Templates and Query rows, so every device run
    would have failed. It now looks for Settings and Bookmarks.
- **A bug the new route exposed.** The Pages list parks visible rows'
  subtrees for 8 s (#2850). A page restored from Trash and reopened from
  Pages within that window showed its pre-restore blocks. A parked entry now
  expires once an immediate graph-structure count has moved. The existing
  key is debounced by 150 ms, which leaves a window.

## Verified

- Guard scripts: zero import cycles, store layering OK, lib layering at
  its baseline. knip, typos and markdownlint are clean.
- vitest across layout, PageBrowser, settings, pages, App, agenda, hooks,
  lib and stores passed, and `npm run typecheck` is clean.
- Playwright: every touched spec passed (smoke, settings, trash-bulk,
  features-coverage, mobile-overflow, graph-view, history, sync-ui and
  others). `trash-bulk` fails without the prefetch fix.
- Each new unit test was shown red against a scratch-backed mutation, and
  the reviewer re-ran two of those mutations.
