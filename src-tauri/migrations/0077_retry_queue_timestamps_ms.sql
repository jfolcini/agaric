-- Issue #109 Phase 2: migrate `materializer_retry_queue.created_at` and
-- `materializer_retry_queue.next_attempt_at` from TEXT to INTEGER
-- milliseconds-since-UNIX-epoch (UTC), the canonical timestamp encoding
-- (Phase 1 / migrations/AGENTS.md; written via `crate::db::now_ms()`).
--
-- This table is independent of the `op_log.created_at` cluster: both columns
-- are self-generated (the sweeper computes `next_attempt_at` from
-- `now + backoff`, `created_at` defaults to "now") and only ever compared in
-- Rust / against a self-computed cutoff (`fetch_due`'s `next_attempt_at <= ?`
-- binds the current instant; `give_up_reason` diffs `created_at` against now).
-- No cross-table SQL predicate.
--
-- It also resolves the format-mixing #109 flagged: the old
-- `DEFAULT CURRENT_TIMESTAMP` produced space-separated TEXT
-- ("2026-05-27 12:00:00") while the sweeper wrote RFC 3339
-- ("2026-05-27T12:00:00.000Z"). `julianday()` parses both forms, so the
-- backfill is uniform; the new INTEGER `DEFAULT` removes the divergence.
--
-- Rebuild recipe (precedent 0061/0062/0073). The table is already STRICT.
-- The live index is `idx_materializer_retry_queue_due` (0063 dropped the
-- earlier `_next` index); it is recreated against the rebuilt table. PK
-- (block_id, task_kind) preserved.

CREATE TABLE _new_materializer_retry_queue (
    block_id   TEXT NOT NULL,
    task_kind  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
        CHECK (created_at >= 0),
    next_attempt_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
        CHECK (next_attempt_at >= 0),
    PRIMARY KEY (block_id, task_kind)
) STRICT;

INSERT INTO _new_materializer_retry_queue
    (block_id, task_kind, attempts, last_error, created_at, next_attempt_at)
    SELECT block_id, task_kind, attempts, last_error,
           CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000.0) AS INTEGER),
           CAST(ROUND((julianday(next_attempt_at) - 2440587.5) * 86400000.0) AS INTEGER)
    FROM materializer_retry_queue;

DROP TABLE materializer_retry_queue;
ALTER TABLE _new_materializer_retry_queue RENAME TO materializer_retry_queue;

CREATE INDEX IF NOT EXISTS idx_materializer_retry_queue_due
    ON materializer_retry_queue (next_attempt_at, block_id, task_kind);
