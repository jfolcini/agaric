# Session 2495 — real-lane specs for search paging, query grouping and reference filters

Real-backend specs for three items the mock cannot show failing: two from
#5738 and the References filters from #5736. All three seed through Settings ›
Data's markdown import, now shared as `importMarkdownPage` in
`e2e-tauri/helpers.ts`.

**`e2e-tauri/search-load-more.e2e.ts`:**
- **Setup:** imports more matching blocks than one page holds, each with a
  sequence number.
- **Paging:** the first page holds exactly `PAGINATION_LIMIT` rows and offers
  Load more. Pressing it until it goes away lists every block exactly once.
- **Virtualized list:** the spec scrolls the list and keys rows by
  `data-index`.

**`e2e-tauri/advanced-query-group-by.e2e.ts`:**
- **Grouping:** tasks in several states, grouped by State, give one header
  per state with its block count, in the engine's order.
- **Count aggregate:** per-group chips and a global total.
- **After Journal and back:** all of it is asserted again.

**`e2e-tauri/references-status-priority-filters.e2e.ts`:**
- **Sources:** five blocks link one page. Each has a different mix of state
  and priority, so every filter selects a different set.
- **Filters:** Status, Priority and each one's `none` list exactly their
  sources and the "Showing N of M" line. The Priority filters run after
  leaving the page and coming back.
- **Why the real lane:** the backend compiles `Not` as
  `NOT COALESCE((inner), 0)`, while the mock evaluates it in JS.

**Found:**
- **Advanced Query in grouped mode** labels the group count "N matching
  blocks".
- **The search summary** read "1 pages".
- **A click on *Add filter*** below a block open in the editor is lost.

Each of these is fixed in its own PR. The References spec leaves the editor
first, because more of the panel's controls lose that click.

**Review:**
- **Status none and Priority none** expected the same single row, so a
  builder that sent the Status complement for Priority none still passed. A
  fifth source, a state without a priority, now tells them apart.
- **Escape:** a single press could arrive before the editor opened, so it now
  repeats until the editor is gone.
- **The search spec's FTS retry** could never retry, because an inner wait
  used the outer wait's whole budget. It now re-searches on a short poll.

**Shown red:**
- **Load more:** the FTS cursor ignored, so every page re-reads page 1.
- **Group by:** the State group key reading `priority`.
- **References:** `AddFilterRow` restored from before #5796, the backend's
  `Not` without `COALESCE`, and Priority none sending the Status complement.

**Ran:**
- each spec on a binary rebuilt from the clean tree, the References spec
  three times in a row;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint and
  oxfmt.
