-- BUG-22: Persistent retry queue for failed background materializer tasks.
--
-- Background tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, etc.) that fail
-- after the in-memory retry loop exhausts are recorded here so a periodic
-- sweeper can retry them later. The sweeper runs every 60s in the background
-- and on app boot. `next_attempt_at` uses exponential backoff (1m, 5m, 30m,
-- 1h cap) and `attempts` records the running failure count.

CREATE TABLE IF NOT EXISTS materializer_retry_queue (
    block_id TEXT NOT NULL,
    task_type TEXT NOT NULL,   -- "UpdateFtsBlock" | "ReindexBlockLinks" | …
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (block_id, task_type)
);

CREATE INDEX IF NOT EXISTS idx_materializer_retry_queue_next
    ON materializer_retry_queue (next_attempt_at);
