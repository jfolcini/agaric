-- C-2b: track the highest op_log.seq successfully applied by the
-- foreground materializer consumer, so boot-time replay can re-enqueue
-- ops missed by mid-flight crashes / fg_apply_dropped events.
--
-- Single-row table: id=1, enforced by CHECK. The cursor advances inside
-- the same BEGIN IMMEDIATE tx as the apply, so `op + cursor advance`
-- are atomic — a crash leaves the cursor pointing at the LAST-applied
-- seq (never ahead of state).
--
-- A future per-table-cursor refinement is possible (each derived cache
-- tracks its own watermark) but the foreground apply is the convergence
-- bottleneck — caches are rebuildable from primary state.

CREATE TABLE IF NOT EXISTS materializer_apply_cursor (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    materialized_through_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO materializer_apply_cursor (id, materialized_through_seq, updated_at)
    VALUES (1, 0, '2026-04-30T00:00:00Z');
