## Session 1139 — #2042 Part A: grouped-backlink keyset pushdown (2026-06-30)

| Field      | Value                                              |
| ---------- | -------------------------------------------------- |
| Session    | 1139                                               |
| Issue      | #2042 (Part A)                                      |
| Branch     | claude/issue-2042-pagecache-bg                      |
| Date       | 2026-06-30                                          |
| Area       | src-tauri/src/backlink (grouped backlinks)         |

## Summary

Pushed the grouped-backlink group dimension into SQL with a keyset cursor so
per-page cost is proportional to the page, not the whole post-filter source
set. Previously `eval_backlink_query_grouped` over-fetched the ENTIRE
post-filter source-id set into a Rust `FxHashSet`, resolved root pages for ALL
of them, sorted the full group list, then sliced to one page — so every page
request reloaded all (e.g. 50k) ids regardless of `page.limit`.

## Change

`eval_backlink_query_grouped` (backlink/grouped.rs) — kept steps 1
(`total_count` COUNT) and 2 (filter resolution → `filter_json`) unchanged.
Replaced the tail with:
- (a) `filtered_count` via `SELECT COUNT(DISTINCT bl.source_id)` over the same
  predicates + `filter_json`.
- (b) Grouped keyset page query: `GROUP BY b.page_id`, returns
  `(page_id, page_title, cnt)`, `ORDER BY (p.content IS NULL) ASC, p.content
  ASC, b.page_id ASC` (matches `cmp_group` exactly), `LIMIT limit+1` for
  `has_more`. A three-arm row-level keyset WHERE (equivalent to a group-level
  keyset since the columns are constant per group) resumes strictly after the
  cursor; #625 vanished-cursor resume is preserved by construction. Per-group
  `truncated` derives from the TRUE `cnt`.
- (c) Member-id fetch for VISIBLE groups only via `SELECT DISTINCT
  bl.source_id, b.page_id … AND b.page_id IN (json_each(?))`, then existing
  `sort_ids` + `MAX_BLOCKS_PER_GROUP` cap.
- (d) Existing `fetch_block_rows_by_ids` + distribution for the capped ids.

`DISTINCT bl.source_id` is used in the count and member fetch to preserve the
old `FxHashSet` set semantics (parity/safety; `block_links` already has
`PRIMARY KEY (source_id, target_id)`). `cmp_group` / `groups_after_cursor`
retained — still used by `eval_unlinked_references` (unchanged, out of scope —
already bounded by `FTS_ROW_CAP`). Only runtime `sqlx` builders used → no
`.sqlx` regen. Added `eval_grouped_keyset_per_page_cost_is_bounded_2042`
proving bounded per-page cost and complete, duplicate-free cursor-walk
coverage.

## Part B (not done — documented)

The issue's other half (move the per-op `inbound_link_count` recompute off the
foreground `apply_op_tx`) is intentionally NOT pursued: doing so reverts the
deliberate #1548 synchronous-inbound-count guarantee (three pinning tests in
`materializer/tests/pages_cache_parity.rs`, notably
`inbound_count_correct_synchronously_without_bg_reindex`), and
`maintain_pages_cache_counts_after_op` also performs in-tx side effects
(`reindex_block_links_conn`, `reparent_moved_subtree_page_id`, page-create row
INSERT) that must stay foreground. The interactive hot path already recomputes
counts SCOPED to affected pages via the command layer (#417/#461), so the
remaining per-op cost is on the replay/sync/convergence path only. Keeping the
recompute foreground is the correct call.

## Verification

- `cargo test -p agaric --lib backlink::` — 212 passed, 0 failed (all pinned
  grouped/#625/total_count/caps/compound/blockrow/parity tests + the new
  bounded-cost cursor-walk test).
- `cargo clippy -p agaric --lib --tests -- -D warnings` — clean.
- `cargo fmt -p agaric -- --check` — clean.
