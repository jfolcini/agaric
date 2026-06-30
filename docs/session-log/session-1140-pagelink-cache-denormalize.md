## Session 1140 — #2070: list_page_links cache predicate denormalisation (2026-06-30)

| Field   | Value                                                  |
| ------- | ------------------------------------------------------ |
| Session | 1140                                                   |
| Issue   | #2070                                                  |
| Branch  | claude/issue-2070-pagelink-cache-flatten               |
| Date    | 2026-06-30                                             |
| Area    | src-tauri/src/cache/page_links + commands/pages/links  |

## Summary

`list_page_links` (graph view) exceeded the 200 ms interactive SLO (~1.3 s @
100K). The issue's literal premise was STALE: it blamed a "3× blocks join to
recover titles", but that title roll-up was already removed by migration 0065 —
`page_link_cache` carries no titles and the frontend sources them elsewhere.
The REAL remaining cost was the TWO residual `blocks` joins the read still did
purely to enforce `src.deleted_at IS NULL`, `tgt.deleted_at IS NULL`, and
`tgt.block_type = 'page'`. This change denormalises those three predicates into
the cache so the unscoped (`SpaceScope::Global`) read — the path the SLO bench
measures — becomes a single covering-index scan with ZERO `blocks` joins.

## Change

- Migration 0096 (additive ALTER, 0065 untouched; the STRICT-tables hook only
  inspects `CREATE TABLE`, so `ADD COLUMN` is compliant): adds `src_deleted`,
  `tgt_deleted`, `tgt_is_page` integer flag columns to `page_link_cache`,
  backfills them from current `blocks` state, and adds a partial covering index
  `idx_page_link_cache_live` over `(source_page_id, target_page_id, edge_count)
  WHERE src_deleted = 0 AND tgt_deleted = 0 AND tgt_is_page = 1`.
- Read (`list_page_links_inner[_split]`): dropped both `JOIN blocks` lines;
  added `plc.src_deleted = 0 AND plc.tgt_deleted = 0 AND plc.tgt_is_page = 1`.
  Self-edge filter, space-members CTE, tag union, lazy-rebuild guard, and the
  GRAPH_EDGE_WARN_THRESHOLD tripwire are all preserved; `PageLink` output is
  unchanged (no bindings regen).
- Rebuild (both single-pool and split impls): keeps the legacy
  `WHERE sb.deleted_at IS NULL` so `edge_count` counts only live source blocks,
  and denormalises the flags by joining `blocks` for the target
  (`tgt_deleted`/`tgt_is_page`) and the source PAGE
  (`src_deleted = MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE
  (sp.deleted_at IS NOT NULL) END)` via `LEFT JOIN blocks sp` on the rolled-up
  page id — a missing/purged source page maps to deleted, matching the legacy
  inner-join mask). This makes rebuild == incremental == legacy exactly.
  `REBUILD_CHUNK` recomputed from `MAX_SQL_PARAMS / 3` (333) to `/6` (166) for
  the new 6-column INSERT.
- Incremental `reindex_page_link_cache_for_block`: `desired` CTE + UPSERT
  extended to compute and refresh all three flags (`src_deleted` from the
  source page, `tgt_deleted`/`tgt_is_page` from the target block) so an
  incremental upsert never resurrects a row with stale default flags.
- Regenerated the `.sqlx` offline cache (`cargo sqlx prepare -- --tests`): net
  3 entries replaced (the shared rebuild SELECT, the read query, the incremental
  reindex UPSERT).

## Verification

- `cargo test -p agaric --lib page_link` — 42 passed, incl. the frozen
  `page_link_cache_read_path_matches_legacy_query` (UNMODIFIED correctness
  gate) and `page_link_cache_denormalized_flags_match_legacy_after_mutation`
  (soft-deleted target via full rebuild; source edit via incremental reindex; a
  non-page target; AND a live page with one of two source blocks deleted —
  asserting the edge stays visible with ref_count = 1, not 2/masked — the exact
  case that catches a rebuild/edge-count divergence).
- `cargo test -p agaric --lib commands::tests::query_cmd_tests` — 86 passed
  (space-scoping/parity for list_page_links).
- `cargo test -p agaric --lib materializer::dispatch` — 43 passed.
- `cargo clippy -p agaric --all-targets -- -D warnings` — clean.
- `cargo fmt -p agaric -- --check` — clean.
- Migration checks: immutable (0065 untouched), strict-tables, rebuild-cascade,
  and dynamic-sql all pass.
- The `interactive_slo` `bench_list_page_links` `problem_skipped` gate is kept
  in place (this PR does not promote the row to the green tier); its doc note
  records the SLO is to be confirmed under budget on the nightly bench-compile
  lane (the 100K release bench is not runnable in the dev sandbox).

Note: the issue's "titles / 3× join" premise was stale — the title roll-up was
already removed by migration 0065. This fix instead denormalises the
deleted/is_page predicates, which were the actual remaining bottleneck.
