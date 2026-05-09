-- PEND-09 Phase 1 day-4 — persistent parity sink for shadow-mode dual-write.
--
-- The in-memory `ShadowParitySampler` ring buffer (default 1024 events,
-- src/loro/parity.rs) is the cheap first sink for diffy-vs-Loro divergence
-- observations.  Day-4 adds the persistent table so we can accumulate
-- weeks of shadow-mode statistics across process restarts and across all
-- five op-type classes without losing the tail of the ring.
--
-- The ring is the "online" buffer; this table is the "offline" sink.
-- A periodic flush (wired in day-5) drains the ring into this table; a
-- retention purge (function landed in day-4, periodic call wired in
-- day-7+) deletes rows older than 30 days so the table doesn't grow
-- unbounded.
--
-- ## Columns
--
-- - `id` — surrogate primary key.  `INTEGER PRIMARY KEY AUTOINCREMENT`
--   so deletions can never recycle ids and a future "tail since id N"
--   query has stable monotonic ids.
-- - `op_id` — caller-supplied identity, today `"<device_id>/<seq>"` from
--   `merge::apply::shadow_dispatch_for_record`.  Indexed for the "show
--   me parity history for this op" debug query.
-- - `space_id` — the engine partition key; one engine per space.
-- - `op_type` — the diffy op_type ("create_block" / "edit_block" / …)
--   so we can `GROUP BY op_type` for the per-op-type divergence rate.
-- - `diffy_result` / `loro_result` — the compact summary strings the
--   shadow_apply dispatcher produces (e.g. `"create:<block_id>"`).
--   Keeping both sides as the literal summary lets us reconstruct the
--   bucket A/B/C/D classification offline (day-6 deliverable) without
--   re-running the merge.
-- - `matched` — boolean (0/1) for the coarse string-equality check
--   `shadow_apply` performs today.  Indexed so the divergence-rate
--   query (`SELECT COUNT(*) WHERE matched = 0`) is O(matches) not
--   O(table).
-- - `bucket` — bucket A/B/C/D classification (see SPIKE-REPORT.md §3
--   "Bucket distribution").  NULL until the day-6 classifier runs;
--   indexed implicitly via the matched index for the common
--   "bucket IS NULL AND matched = 0" pending-classification query.
-- - `created_at` — milliseconds since Unix epoch (i64).  Matches the
--   `ParityEvent.timestamp` ms unit (changed from seconds in day-4 to
--   match SystemTime::now().duration_since(UNIX_EPOCH).as_millis()).
--   Indexed so the retention purge `WHERE created_at < ?` is a range
--   scan, not a full table scan.
--
-- ## STRICT
--
-- New table, so STRICT applies (PEND-07 policy).  All columns have
-- explicit types; no INTEGER affinity tricks.

CREATE TABLE merge_parity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id        TEXT    NOT NULL,
    space_id     TEXT    NOT NULL,
    op_type      TEXT    NOT NULL,
    diffy_result TEXT    NOT NULL,
    loro_result  TEXT    NOT NULL,
    matched      INTEGER NOT NULL,
    bucket       TEXT,
    created_at   INTEGER NOT NULL
) STRICT;

-- Index for the retention purge (`DELETE WHERE created_at < ?`) and the
-- "tail of the last hour" debug query.  Without this, every purge cycle
-- would be a full table scan.
CREATE INDEX idx_merge_parity_log_created_at ON merge_parity_log (created_at);

-- Index for the "show me all parity events for this op_id" debug
-- query.  op_id is `<device_id>/<seq>` so it's high cardinality
-- and a regular index is fine.
CREATE INDEX idx_merge_parity_log_op_id ON merge_parity_log (op_id);

-- Index for the divergence-rate query (`COUNT(*) WHERE matched = 0`)
-- and the day-6 classifier scan (`WHERE matched = 0 AND bucket IS NULL`).
-- A two-value column normally doesn't index well, but the matched-0
-- subset is the small one (the whole point of shadow-mode ROI is that
-- divergence stays low) so the index pays for itself on the scan side.
CREATE INDEX idx_merge_parity_log_matched ON merge_parity_log (matched);
