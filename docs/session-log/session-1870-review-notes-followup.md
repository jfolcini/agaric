# Session 1870 — review notes from #5235 and #5261

This applies the non-blocking review notes from #5235 (header back/forward
history) and #5261 (stale-state bug sweep), both merged and green, in one
follow-up, as `batch-issues` §7 asks. Each note was checked against the code
before acting on it.

## Fixed

- **Back between two pages in one tab (#5235).** `replayPage` pushed the
  target page whenever it was not the tab's top, so P1 → P2 → Back →
  Forward → Back left the tab's stack as [P1, P2, P1, P2, P1], and every step
  reordered the recents strip. When the target is the entry directly below
  the top, Back now pops through the tabs store's existing `goBack`, the
  same pop the in-tab Back uses, which records no visit. The comment that
  blamed renames is corrected: matching is by page id, so a rename never
  reaches that branch.
- **`currentNavLocation` (#5235)** loses its unused `export`.
- **One `isEditableTarget` (#5261).** Five identical input / textarea /
  contenteditable checks collapse into one export in `keyboard-config`, which
  every caller already imports:
  - the block tree's `isTextField`;
  - `graph-sim-helpers`;
  - `useUndoShortcuts`;
  - `useJournalAutoCreate`;
  - `PdfViewerDialog`.

  Three look-alikes stay as they are, because they also accept
  `contenteditable="true"` by attribute, which the jsdom tests rely on:
  - `isTypingInField`;
  - `use-sidebar-keyboard`;
  - `useAppDialogs`.
- **Unscoped tags (#5261).** SQLite treats NULLs as distinct, so migration
  0121's `UNIQUE (space_id, name)` does not stop two unscoped tags with the
  same name. A comment at the Rust dedup in `next_desired_winner` now says
  that dedup is load-bearing for them. Migrations are append-only, so the
  comment lives at the code.

## Not changed

- **Back stays enabled over deleted pages (#5235, first review).** The
  premise no longer holds. The back-loop fix already drives `disabled`
  through `canStep`, the same skip rule `step()` uses. Two
  `HistoryNavButtons` tests cover it.
- **Undo of a space move does not re-nest detached pages (#5261).** This is a
  real user-visible gap and needs a design choice, so it is filed as #5267.
- **Cost-only notes on #5261, no user-visible failure:**
  - the Pages section refetches on every structure bump;
  - a tag rename makes a second name-bus broadcast;
  - each sync session ends the inbound debounce early;
  - `reloadChangedPageStores` runs on both `sync:complete` and the later
    `blocks:changed`.

## Verified

- vitest: 12 files, 514 tests, covering:
  - navigation history, HistoryNavButtons, back handlers, tabs;
  - both keyboard-shortcut hooks, graph-sim helpers, keyboard-config;
  - `useUndoShortcuts`, `useJournalAutoCreate`, `PdfViewerDialog`.
- `npm run typecheck` and type-aware oxlint are clean on the changed files.
- Playwright: `navigation-history` and `inner-links`, 27 tests, pass.
- The new replay test was falsified twice on a copy. Disabling the pop
  branch fails the stack assertion. Popping and then also navigating fails
  the recents assertion.
