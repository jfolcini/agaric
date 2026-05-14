-- SQL-review M-4 (sql-review-2026-05-14 §M-4): replace the
-- single-column `idx_materializer_retry_queue_next` from migration 0028
-- (re-declared identically in migration 0044's table rebuild) with a
-- covering index that includes the two columns the sweeper actually
-- projects.
--
-- Sweeper SELECT (src-tauri/src/materializer/retry_queue.rs:425-427):
--   SELECT block_id, task_kind FROM materializer_retry_queue
--   WHERE next_attempt_at <= ?
--   ORDER BY next_attempt_at ASC LIMIT ?
--
-- With the old single-column `(next_attempt_at)` index the planner can
-- range-scan the prefix but still has to fetch each matching row to
-- read `block_id` and `task_kind`. At 10K retry rows with most rows
-- future-dated this becomes a non-covering scan + per-row back-row
-- lookup. The new index leads on the WHERE/ORDER-BY column and trails
-- the two projected columns so the index is self-sufficient.
--
-- The plan originally proposed a partial filter
-- `WHERE next_attempt_at <= CURRENT_TIMESTAMP`, but SQLite evaluates
-- `CURRENT_TIMESTAMP` at index-creation time (not at query time), so
-- the partial predicate would freeze to the migration timestamp and
-- exclude every row that becomes due later. A full-table covering
-- index is what the sweeper actually needs.
--
-- Index renamed from `idx_materializer_retry_queue_next` to
-- `idx_materializer_retry_queue_due` so the covering shape is
-- self-documenting; keeping the old name would mislead readers into
-- assuming a single-column index.

DROP INDEX IF EXISTS idx_materializer_retry_queue_next;

CREATE INDEX IF NOT EXISTS idx_materializer_retry_queue_due
    ON materializer_retry_queue (next_attempt_at, block_id, task_kind);
