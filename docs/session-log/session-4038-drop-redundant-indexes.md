# Session 4038 — Migration 0130 drops two redundant indexes

#6522's last box. Picked up from the handover (#6667): the branch held three tests and no migration.

## What changed

- **Migration `0130_drop_redundant_indexes.sql`** drops `idx_op_log_block_id`, a prefix of `idx_op_log_block_created (block_id, created_at)`, and `idx_loro_doc_state_updated_at`, which indexes a table with one row per space and which no query reads.
- `op_log_block_id_indexes_post_migration_0048` asserted the single-column index "must remain". It now asserts 0130 dropped it and the composite stays. `perf26_block_id_index_exists` asserted the same and is replaced by a plan test for `find_prev_edit`'s create-op fallback.
- The comments naming the dropped index in `pagination/history.rs`, `filters/primitive.rs`, `reverse/property_ops.rs` and two test files name the composite, or the migration that dropped it.

## Traps

- `EXPLAIN QUERY PLAN` reads `sqlite_stat1` only on the connection that ran `ANALYZE`, so each plan test pins one connection. The per-block History test asserts the plan with statistics and without.
- The search-index change on `claude/6534-fts-single-block-update` also took `0130`. It lands second and becomes `0131`.
- The browser mock holds no indexes, so the migrations rule asks nothing of it here.
- The query texts did not change, so `just gen-sqlx` rewrote nothing in `src-tauri/.sqlx`.

## Verified

- `op_log_0130_drops_redundant_indexes_and_keeps_rows_6522`, `block_history_plan_seeks_block_created_index_6522`, `find_prev_edit_create_fallback_seeks_block_created_index_6522`, `op_log_block_id_indexes_post_migration_0048`: green. The first and last go red with the `DROP INDEX idx_op_log_block_id` line removed.
- `node scripts/check-migration-test-coverage.mjs`, `cargo clippy --workspace --all-targets -- -D warnings`, the migration and history tests under nextest.
- The full suites were left to CI.
