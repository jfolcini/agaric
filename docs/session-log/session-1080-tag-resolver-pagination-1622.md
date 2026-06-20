# Session 1080 — /batch-issues loop: tag-resolver SQL-pushdown pagination, batch 28 (2026-06-20)

## What happened

First of the heavy-tier deep-review items in the overnight `/loop /batch-issues` run,
built in worktree `wt-batch28`. A HIGH-severity perf rewrite of the tag-query boolean
resolver, adversarially reviewed with parity against the legacy resolver as oracle
(security-relevant: a wrong set-op or complement universe would leak/hide blocks).

## Shipped

PR `fix/tag-resolver-pagination-1622`:

- **#1622** (HIGH, perf) — the #414 LIMIT/cursor fast path only covered single
  Tag/Prefix leaves; the And/Or/Not arm materialized the ENTIRE matching id set into an
  `FxHashSet`, serialized it to a JSON array, and re-parsed it via
  `IN (SELECT value FROM json_each(?))` on every page. For `mode="not"` it computed the
  full complement (all blocks − matched) — O(N_blocks) memory + serialization per page.
  Replaced with a pushed-down SQL compiler `compile_candidate_subquery` that turns the
  boolean tree into one `b.id IN (<subquery>)`: Tag/Prefix → the existing leaf UNION
  body; **And → `INTERSECT`**, **Or → `UNION`**, **Not → `… b.id NOT IN (<inner>)`**
  over the non-deleted universe (byte-identical to the old complement). Each compound
  child is wrapped `SELECT block_id FROM (<child>)` so SQLite's flat compound-SELECT
  grammar can't mis-associate nesting. The clause feeds the existing
  `build_projection_sql` / `run_projection` keyset path, so SQLite applies LIMIT/cursor
  directly — no per-page materialization.

## Edge case handled (a measured finding)

SQLite enforces `SQLITE_MAX_EXPR_DEPTH = 1000`; a pure `Not` chain hits it at ~22-23
nested Nots, while `TagExpr::MAX_DEPTH = 50` accepts deeper trees. Added
`TagExpr::depth()` + `MAX_PUSHDOWN_DEPTH = 15` (well under the ceiling, with headroom):
trees deeper than 15 fall back to the **verbatim** legacy `resolve_expr` + `json_each`
materialization (byte-identical semantics). Real `commands::tags` queries are far
shallower (a few And/Or leaves, a single `Not(Or(...))`), so the fallback is effectively
never taken in production. The caller is unchanged.

## Review pass

Reviewer (APPROVE): verified set-op parity byte-identical to the legacy `resolve_expr`
oracle across the full {Tag,Prefix,And,Or,Not,Not(Or),nested combo} × {inherited} ×
{space} × {block_type} × {page size} matrix (page-by-page ids + has_more + next_cursor),
and **empirically mutation-tested it** (swapping `INTERSECT`→`UNION` and `NOT IN`→`IN`
each failed the parity tests). Confirmed the highest-risk Not-complement universe is
byte-identical (same non-deleted universe, empty-inner case, soft-delete exclusion),
that `NOT IN`/NULL can't drop rows (every selected id column is `TEXT NOT NULL` in
schema), the depth cutover compiles+runs at 15 and falls back at 16 (both match the
oracle), positional binds in exact placeholder order (injection-safe), and zero
dynamic-SQL delta (the composed SQL flows through the one existing `query_as`
projection site). `clippy --all-targets` clean; 392 tag tests pass.

## Notes

- Files: `tag_query/resolve.rs`, `tag_query/query.rs`, `tag_query/mod.rs`. Caller
  `commands/tags.rs` unchanged; public signature untouched; no `.sqlx` change.
- Branch base is current `origin/main`.
