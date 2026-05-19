# PEND-69 — Search partition correctness + post-fetch filter pushdown

> The PEND-67 / PEND-61 partitioned search pipeline (`search_blocks_partitioned`) has two correctness gaps and one redundant computation surfaced by the 2026-05-19 backend audit (round 2). All three affect every caller (desktop Cmd+K palette, mobile search sheet, future Pages-view filter UI), not just one surface.

## TL;DR

- **F1.** Partitioned scan fires one rank-ordered query capped at `min(page_limit + block_limit + 1, 100) = 49` rows, then filters `block_type == "page"` in Rust. If 49 content blocks rank above the only page hit, the `pages` partition returns empty even though pages exist beyond the scan window. `pages.has_more` is `false` (it only flips at the global `MAX_SEARCH_RESULTS=100` ceiling), so the frontend has no signal to escalate.
- **F2.** Regex-mode `block_type` filter at `toggle_filter.rs:168-170` is applied via `Vec::retain()` over the 1000-row pre-filter scan. A page-only regex query asks SQL for the 1000 most recent ANY-type rows, then drops everything non-page client-side. With a content-heavy DB, zero pages can be returned while thousands of matching pages exist.
- **F5.** The SQL `snippet(fts_blocks, …)` function runs server-side for every returned row, even when the regex-toggle post-filter at `toggle_filter.rs:371` immediately clears `row.snippet = None`. 49 wasted snippet walks per IPC in the regex+toggles path.

## Current state — verified

- `src-tauri/src/commands/queries.rs:932-963` — `search_with_toggles_partitioned` does one scan + in-Rust partition split.
- `src-tauri/src/fts/search.rs:23, 720` — `MAX_SEARCH_RESULTS=100`; `ceiling_hit` only signals the GLOBAL cap, not the per-partition cap.
- `src-tauri/src/fts/toggle_filter.rs:118, 168-170` — `REGEX_PRE_FILTER_CAP=1000` + post-fetch `Vec::retain()` on `block_type`.
- `src-tauri/src/fts/search.rs:395` — `snippet(fts_blocks, 1, '<mark>', '</mark>', '…', 32)` is inline in the SQL builder, always.
- Frontend workaround in `src/components/CommandPalette.tsx:418-424, 439-448` — `[[page]]` autocomplete fires a separate `searchBlocks({ blockTypeFilter: 'page' })` to guarantee page coverage. Confirms F1 is observable in practice.

## Design

### F1 — two-scan partition guarantee

Replace the single-scan-then-partition shape with two parallel SQL scans inside `search_with_toggles_partitioned`:

1. Pages scan: `WHERE block_type = 'page'` + rank order + `LIMIT page_limit + 1`.
2. Blocks scan: same builder + `LIMIT block_limit + 1`.

Each scan independently honors `MAX_SEARCH_RESULTS`. The `has_more` field per partition becomes meaningful (`pages.has_more = true` iff the pages scan returned `page_limit + 1` rows).

Concurrency: run both scans on the read pool via `tokio::try_join!`. With `max_connections(4)` we can comfortably afford two reads per IPC. Net latency increase on a warm cache: ~3-5 ms (the second SQLite roundtrip); on cold cache the index page-faults are shared.

The frontend `[[page]]` workaround (`CommandPalette.tsx:418-424`) can then drop its separate `searchBlocks` call — one less IPC per autocomplete keystroke.

### F2 — push `block_type` into SQL in regex mode

`toggle_filter.rs:460-466` builds the pre-filter SQL. Add the `block_type` predicate there instead of post-fetch. Same one-line guard the non-regex path uses at `search.rs:380-385`. Eliminates the 1000-row drag for page-only regex queries.

### F5 — conditional snippet generation

The SQL builder at `search.rs:380` knows the toggle set before the query fires. When `toggles.any() && !toggles.is_regex` (or any path that calls `clear_snippet_if_post_filtered()` downstream), omit the `snippet(...)` column from the SELECT and synthesize `None` server-side. SQLite's `snippet()` is a re-tokenization walk per row; saving 49 of those per IPC is measurable on cold cache.

## Tests

- New: `partitioned_scan_returns_pages_when_blocks_outrank_them` — seed 60 content-heavy blocks ranking above 1 page; assert `result.pages.items.len() == 1`.
- New: `partitioned_regex_page_filter_returns_pages_when_content_dominates` — seed 2000 content blocks + 5 pages matching a regex; assert all 5 pages returned without scanning the 1000-row pre-filter cap.
- New: `partitioned_snippet_skipped_when_post_filter_clears_it` — instrument the SQL trace or count `snippet()` calls to verify zero invocations in the regex-toggle path.
- Update existing: `partitioned_empty_query_returns_empty_partitions` should also cover empty-space (zero pages in space).

## Acceptance criteria

- Pages partition returns pages whenever any match exists, regardless of content-block rank.
- `pages.has_more` accurately reflects per-partition exhaustion (not global).
- Regex page-only queries don't drop pages beyond the 1000-row pre-filter cap.
- `snippet()` doesn't execute when downstream code clears `row.snippet`.
- `cargo nextest run` green across the search test suite.
- `cargo sqlx prepare -- --tests` produces a clean diff (no spurious .sqlx changes).

## Open questions

1. **Migration story for callers that depend on the combined-cap semantics.** Today's `LIMIT min(page_limit + block_limit + 1, MAX_SEARCH_RESULTS)` returns ≤ 49 rows total. Two parallel scans can return up to 49 each = 98 rows for the IPC. Any caller comparing the global count to a budget needs to know. Audit: `searchBlocksPartitioned` callers (palette overlay, mobile sheet, future Pages-view filter).
2. **`tokio::try_join!` watchdog timeout.** If one of the two scans hangs on a pathological filter, should the other complete and return a partial response, or fail fast? Recommendation: fail fast (`AppError::Internal("partition-scan-timeout")`) — bounded by PEND-70's cancellation work.
3. **`has_more` semantics under the two-scan shape.** A partition with exactly `limit` rows returned: do we set `has_more = false` (consumer can confidently render the full set) or query for `limit + 1` and signal accordingly? Recommendation: `limit + 1` probe — costs one extra row of bandwidth per partition, gains accurate pagination.

## Out of scope

- F3 (ULID-based ordering vs cross-device clock skew) — docstring-level fix; tracked here as a related note but not part of this plan.
- F4 (double-allocation in `count_backlinks_batch`) — trivial; will be folded into F1's refactor.
- F7 (glob-OR chain length) — fine at personal-notes scale; revisit if a 10k+ page space surfaces.

## Cost / impact

- **Cost:** M (~6-10 h). One scan-builder refactor (F1) + one SQL predicate addition (F2) + one conditional column projection (F5) + 4 new tests. Touches `search_with_toggles_partitioned`, `toggle_filter.rs`, the SQL builder, and `fts/tests.rs`.
- **Impact:** Correctness across ALL search surfaces; eliminates one frontend IPC per `[[page]]` keystroke; saves ~5-15 ms per IPC in the regex-toggle path on cold cache.
- **Risk:** Medium. SQL builder is the hot path for every search command (palette, page-browser filter, backlinks). The two-scan approach changes the timing characteristics; profile against the existing single-scan baseline before merging.

## Related

- PEND-61 (shipped) — introduced `searchBlocksPartitioned` and the partitioned response shape.
- PEND-67 (shipped) — palette polish; consumes the partitioned scan.
- PEND-62 (shipped) — mobile sheet; surfaces this issue in the embedded palette path.
- PEND-70 (this audit) — server-side cancellation + slow-query logging.
- PEND-71 (this audit) — broader search test coverage matrix.
- `src-tauri/src/commands/queries.rs`, `src-tauri/src/fts/{search,toggle_filter}.rs`
