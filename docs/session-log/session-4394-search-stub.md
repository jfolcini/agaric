# Session 4394 — the mock's search engine is a thin stub

The specs that test what search and the query engine return now run on the real backend, on every PR that reaches them (#6996, #7002). Per the maintainer's decision on #6529, the mock's engine, `handlers/search.ts`, gives way to a stub that answers only what the UI needs.

**The stub (`src/lib/tauri-mock/handlers/search.ts`):**
- **`search_blocks` and `search_blocks_partitioned`:**
  - A case-insensitive substring match on a block's text; a page's title is its content.
  - Results are live blocks in id order: no ranking, toggles or filters.
  - `SearchFilter.scope` still applies and is still refused when empty.
  - A blank query answers nothing.
  - The limit checks stay.
- **`run_advanced_query`:**
  - Evaluates the filter tree with the shared `metaRowMatchesExpr`, in id order, with a last-id cursor.
  - A `fulltext` term is the same substring match.
  - A grouped request answers an empty grouped page, with no aggregates.
- **`filtered_blocks_query`:**
  - Tag filters are unchanged.
  - Property filters are equality only. Any other operator, or a date range, matches nothing.
  - It now validates its limit and pages.
- **`list_unfinished_tasks`:** moved unchanged. The journal boots on it.

**Kept:** the FTS text helpers that `links.ts` and `link-scan.ts` read (`stripForFts` and its kin) move to `src/lib/tauri-mock/fts-text.ts`, with their tests.

**Deleted:**
- the sort, rank, cursor and toggle machinery;
- the `fbq*` value matchers in `shared.ts`, and the last-edited source injection that only the old engine used;
- the mock vitest files and describes that pinned engine semantics, and `tauri-mock.test.ts`'s reserved-column `neq` test, which the stub left vacuous (the reviewer's note).

**Conformance:**
- `QUERY_COMMANDS_BACKEND_ONLY` (`conformance-query.ts`) waives the four commands on the mock side. Each waiver carries a reason: engine semantics, asserted by the backend, and on the bridge by the `REAL_BACKEND_SPECS` specs.
- No command passes the mock leg even alone: un-waiving each failed 2–10 fixtures. Waiving whole commands also keeps related steps together.
- The branch-coverage maps for those commands go with them. The fixtures' `expected` values and the Rust side are unchanged.

**Differences from before:**
- The palette's Tags mode and the `[[` fallback can list other block types, because `blockTypeFilter` is a filter. The `[[` picker filters to pages itself.
- Template pages and saved views are no longer excluded from advanced queries.
- Ascending id order, where the backend's advanced query defaults to newest first.

**Shown red:** `search-stub.test.ts` covers:
- a case-insensitive hit on a title and on content;
- id order over a denser match;
- a blank query;
- the partitions.

Three mutations, each restored afterwards:
- a case-sensitive match reddened 4 tests;
- dropping the blank-query check reddened its test;
- ordering by length reddened the order and partition tests.

Removing the waiver map from `conformance-coverage` reddens the guard, naming all four commands.

**Ran:**
- the full vitest suite;
- `npm run typecheck`, knip, oxlint, oxfmt;
- on the mock, the six search specs not on the bridge list (autocomplete, menus-popovers, observability-tracing, palette-desktop, agenda-virtualization, phone-view-headers): 36 passed;
- the three mock shards:
  - shard 1: 333 passed;
  - shard 2: 461 passed and 15 failed;
  - shard 3: 296 passed;
- a throwaway spec showing the Search view, the `[[` and `#` pickers and the Ctrl+K palette return results in the mock build.

Shard 2's failures are all this container's:
- 13 tests launch a `chrome-headless-shell` it lacks;
- `diagram-legibility`'s two fail the same way on main here, measuring a label at 10.9999px against 11.
