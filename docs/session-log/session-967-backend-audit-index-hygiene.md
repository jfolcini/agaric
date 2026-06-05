## Session 967 — Backend-audit index hygiene + keyset ordering (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | orchestrator-only (mechanical, EXPLAIN-verified) |
| **Items closed** | `#411`, `#413`, `#415`, `#425`, `#431` |
| **Items modified** | — |
| **Tests added** | +0 (no new code paths; existing pagination/backlink/tag suites cover the keyset changes) |
| **Files touched** | 6 |

**Summary:** First batch of the 2026-06-05 SQL backend audit. Adds migration
`0083` with five index changes, each verified with `EXPLAIN QUERY PLAN` to remove
a `SCAN`/`USE TEMP B-TREE FOR ORDER BY` from a hot read or boot path, plus the
matching `ORDER BY`/keyset edits in `list_backlinks` and `list_by_tag` so the
order is index-supplied. Net effect: boot op-log replay, value_ref cascade
deletes, backlink/tag pagination, and the page-browser keyset all become
index-served instead of full-scan-and-sort — the core scaling fixes for the
tens-of-thousands-of-pages-on-mobile goal.

**Files touched (this session):**
- `src-tauri/migrations/0083_backend_audit_index_hygiene.sql` (new, +60)
- `src-tauri/src/pagination/links.rs` (ORDER BY/keyset → `bl.source_id`; doc)
- `src-tauri/src/pagination/tags.rs` (ORDER BY/keyset → `bt.block_id`; doc)
- `src-tauri/src/materializer/handlers.rs` (doc: renamed index)
- `src-tauri/src/filters/primitive.rs` (doc: renamed index)
- `src-tauri/.sqlx/*` (regenerated: 2 queries changed)

**Index changes (all EXPLAIN-verified before/after):**
- `#411` `idx_op_log_seq(seq, device_id)` — boot replay walk `SCAN`+temp-sort → index `SEARCH`.
- `#413` `idx_block_properties_value_ref(value_ref) WHERE value_ref IS NOT NULL` — cascade deletes `SCAN` → covering `SEARCH`.
- `#415` drop `idx_block_links_target`, add `idx_block_links_target_source(target_id, source_id)` — backlink first page temp B-tree removed.
- `#425` drop `idx_block_tags_tag`, add `idx_block_tags_tag_block(tag_id, block_id)` — tag listing temp B-tree removed.
- `#431` widen `idx_blocks_type` to `(block_type, deleted_at, id)` — page-browser keyset temp sort removed.

**Verification:**
- `EXPLAIN QUERY PLAN` on the migrated schema: every targeted `SCAN`/`USE TEMP B-TREE FOR ORDER BY` replaced by an index `SEARCH`.
- `cargo nextest run -E 'test(pagination) or test(backlink) or test(tag) or test(migrat)'` — 748 tests run, 748 passed.
- `cargo check --all-targets` — clean (benches included).
- pre-commit / pre-push hooks — full clippy + push-staged checks.

**Process notes:** The dropped single-column indexes are strict subsets of the new
composites, and no query forces them via `INDEXED BY` (grep-checked), so the drops
are safe write-amplification reductions consistent with `0072_drop_dead_indexes`.

**Commit plan:** single commit; pushed; PR against `main`.
