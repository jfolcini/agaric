-- PEND-03: Widen materializer_retry_queue to cover global cache rebuilds.
--
-- Per-block idempotent tasks (UpdateFtsBlock, ReindexBlockLinks,
-- ReindexBlockTagRefs) are persisted on failure since BUG-22 (migration
-- 0028). Global cache rebuilds (RebuildTagsCache, RebuildPagesCache,
-- RebuildAgendaCache, RebuildProjectedAgendaCache,
-- RebuildTagInheritanceCache, RebuildPageIds, RebuildBlockTagRefsCache)
-- were silently dropped on queue saturation or handler failure, leaving
-- caches stale until the next mutation re-dispatched the rebuild.
--
-- Global tasks use the literal '__GLOBAL__' as block_id since SQLite
-- STRICT mode requires PRIMARY KEY columns to be NOT NULL. ULIDs cannot
-- collide with this sentinel (Crockford base32 uppercase 26-char vs.
-- lowercase + underscores).
--
-- task_type column is renamed to task_kind to widen its semantic from
-- "per-block FTS / link / tag-ref reindex" to "any retryable materializer
-- task, per-block or global rebuild".
--
-- SQLite cannot rename / change-NOTNULL on a primary-key column in
-- place; the standard idiom is table recreation. The new table uses
-- STRICT (PEND-07 policy applied here for the first time on this table).
-- The old table is dropped immediately after the rename so no orphan
-- materializer_retry_queue_new survives a crash mid-migration.

CREATE TABLE materializer_retry_queue_new (
    block_id   TEXT NOT NULL,        -- per-block tasks use the real id, global rebuilds use the literal '__GLOBAL__'
    task_kind  TEXT NOT NULL,        -- replaces task_type, covers per-block AND global variants
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (block_id, task_kind)
) STRICT;

INSERT INTO materializer_retry_queue_new (block_id, task_kind, attempts, last_error, created_at, next_attempt_at)
  SELECT block_id, task_type, attempts, last_error, created_at, next_attempt_at
  FROM materializer_retry_queue;

DROP TABLE materializer_retry_queue;
ALTER TABLE materializer_retry_queue_new RENAME TO materializer_retry_queue;

CREATE INDEX IF NOT EXISTS idx_materializer_retry_queue_next
    ON materializer_retry_queue (next_attempt_at);
