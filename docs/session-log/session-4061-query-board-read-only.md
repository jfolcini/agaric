# Session 4061 — Query board, read-only slice (#6542)

The maintainer opened plan #6542 on 2026-11-13: a design note first, then a first read-only slice if the note left nothing open. The note is a comment on the issue; this is the slice.

## What the note decided

- **A column is a flat query, not a group.** The grouped path of `run_advanced_query` pages over groups by count, previews ten rows in `id DESC` whatever the sort, and never returns a value no block has. The flat path already takes a filter, the sort, a cursor and a validated limit. So each column runs the builder's filter AND-ed with its own leaf through `useAdvancedQuery`. No backend, IPC, store or schema change; the only new state is `view` on the existing per-space controls and on a saved view's payload.
- **Boards exist for task state and `select` properties only**, the keys with a closed, ordered value set a later drop can write to. Column order is the option order of the definition, so nothing new is persisted.
- A list view's saved payload is unchanged: `view` is written only for a board.

## Traps

- The browser mock stubs the grouped path (one synthetic bucket), so a board built on it could not have been shown failing in Playwright. The flat path is modelled faithfully, which is the second reason for the design.
- `EmptyState` is a labelled region. Five empty columns with one message fail axe's `landmark-unique`, so the message names its column.
- Advanced Query opened every result as an "Untitled" page: it handed `onPageSelect` the id alone. Found when the board's spec asserted the opened page's title. Fixed for the list, the groups and the board, where the titles are already in hand.
- The cloud container's Chromium is one revision behind the pinned Playwright; `docs/BUILD.md` § Cloud container has the symlink recipe.

## Shipped

One PR for #6542: `board-columns.ts`, `QueryBoard.tsx`, a `cards` layout on `QueryResultList`, the *View* toggle in `QueryControlsBar`, `enabled` on `useAdvancedQuery`, and `e2e/advanced-query-board.spec.ts`.

Existing assertions edited, all for the new `view` field: the default controls in `advancedQuery.test.ts` now include `view: 'list'`. Fixtures that build controls by hand gained the field with no assertion changed.

## What ran

Full vitest, `npm run typecheck`, `npm run lint`, `prek run --all-files` and the manual stage. Playwright on the mock: the new spec, shown red by dropping the column's filter (the DONE card showed up under TODO), and the specs `just e2e-related` selects. Vitest falsifications, each one command that restored on exit: the column filter, the hidden "Other values" column, the page title on open, and the list's query staying off behind the board.

Not run here: the WebdriverIO lane (no `cargo-tauri` in the container), and the issue's 500-card measurement. A column renders one page of 50 at a time, so the board's DOM grows with what the user loads; nothing was measured.

Looked at in Chromium at 1280 px and 360 px wide: the builder keeps the list column's width, the board spans the view and scrolls sideways, a phone shows one column and the edge of the next.
