## Session 972 — Tag-query leaf pushdown (no full-set materialization) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#414` |
| **Items modified** | — |
| **Tests added** | +2 backend (72-combo differential matrix + block_tag_refs-only) |
| **Files touched** | 1 |

**Summary:** Large refactor from the 2026-06-05 SQL backend audit. `eval_tag_query`
resolved the FULL `FxHashSet<String>` of every matching block id, serialised ALL
of them to a JSON string, and bound it into `json_each(?)` on every page request
— a multi-hundred-KB string built + re-parsed per page for a popular tag. The new
fast path for the two leaf expression kinds (`TagExpr::Tag`, `TagExpr::Prefix`)
computes the candidate set INSIDE SQLite as `b.id IN (<UNION subquery>)`, so only
one page of rows is ever produced and nothing is materialised into Rust. `And`/`Or`/
`Not` keep the existing resolve-then-project path (genuinely set-combinatorial).

**Files touched (this session):**
- `src-tauri/src/tag_query/query.rs` — leaf fast path + shared `build_projection_sql` / `run_projection` helpers (single source so the leaf and json_each paths cannot drift); +508/-66.

**Correctness:** the leaf candidate subqueries replicate `resolve_tag_leaves` /
`resolve_tag_prefix_leaves` exactly (block_tags ∪ block_tag_refs ∪ block_tag_inherited;
prefix joins tags_cache with `LIKE ? ESCAPE '\'` + DISTINCT), all with
`deleted_at IS NULL`. Candidate values are bound (injection-safe; clauses are static
literals). Pagination (fetch_limit+1 / truncate / has_more / next_cursor / `ORDER BY
b.id ASC`) is shared with the old path.

**Verification:**
- New `fast_path_matches_reference_full_matrix`: differential test over {Tag,Prefix} × {inherited} × {space} × {block_type} × page sizes {1,2,3} (72 combos) asserting the fast path equals an oracle that runs the OLD `resolve_expr` → `json_each` projection — ids, has_more, next_cursor all identical.
- New `fast_path_includes_block_tag_refs_only_block`: a block tagged only via an inline ref appears in the fast-path result.
- `cargo nextest run -E 'test(tag) or test(backlink) or test(graph)'` — 593 passed.
- Independent review: candidate clauses line-by-line match the resolver; bind order/count verified; And/Or/Not unchanged.
- No `.sqlx` change (dynamic `AssertSqlSafe` runtime-checked queries).

**Commit plan:** single commit; pushed; PR against `main`.
