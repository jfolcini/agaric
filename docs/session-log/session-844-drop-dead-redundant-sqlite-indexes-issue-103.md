## Session 844 — drop dead/redundant SQLite indexes (issue #103) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only + 1 review subagent (technical) |
| **Items closed** | #103 (drop two dead/redundant SQLite indexes) |
| **Items modified** | — |
| **Tests added** | +1 backend (EXPLAIN QUERY PLAN guard for `block_links.source_id` lookups via PK autoindex) |
| **Files touched** | 3 |

**Summary:** Closed issue #103 in a single migration. `idx_op_log_device_op_type` (migration 0008, written for diffy-merge divergence detection) has been dead since PEND-09 retired diffy in migrations 0057–0060 — production grep confirms zero callers; only test files use the `(device_id, op_type)` filter shape. `idx_block_links_source` (migration 0020) is fully redundant with `block_links.PRIMARY KEY (source_id, target_id)` on this STRICT non-WITHOUT-ROWID table — the PK B-tree's leading column already covers `WHERE source_id = ?`. Replaced the stale `block_links_source_index_exists` test in `db.rs` (which asserted the dropped index existed) with `block_links_source_lookup_uses_pk_autoindex`, an `EXPLAIN QUERY PLAN` test that locks the planner's choice of `sqlite_autoindex_block_links_1` for source_id lookups so a future schema change can't silently regress to a full-table scan. Tightened one stale comment in `filters/primitive.rs` that mentioned the dropped index name. Migration `0061_fk_cascade_on_blocks_legacy_tables.sql:155-156` still recreates `idx_block_links_source` inside its table rebuild — that's fine, 0061 runs before 0072 on a fresh DB so the final state matches the upgrade path.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (work was a `plan`-labelled GitHub issue, not REVIEW-LATER).
- **Previously resolved:** 1350+ → 1350+ across 843 → 844 sessions.

**Files touched (this session):**
- `src-tauri/migrations/0072_drop_dead_indexes.sql` (new, +21 — two `DROP INDEX IF EXISTS` + provenance comment)
- `src-tauri/src/db.rs` (+18, -8 — replaced index-existence assertion with EQP test)
- `src-tauri/src/filters/primitive.rs` (+2, -2 — drop stale index-name reference in test comment)
- `src-tauri/.sqlx/` — regenerated via `cargo sqlx prepare -- --tests`

**Verification:**
- `cd src-tauri && cargo sqlx prepare -- --tests` — clean.
- `cd src-tauri && cargo nextest run` — 4011 / 4011 pass.
- Technical review subagent — LGTM across correctness / test coverage / conventions / architectural stability.
- `prek run --all-files` — all hooks pass after one cargo-fmt fix (inlined the EQP query call so the SQL fit on one line).

**Commit plan:** single commit on topic branch `pend-103-drop-dead-indexes`; PR against `main`. Closes #103 on merge.
