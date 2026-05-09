-- PEND-09 Phase 2 day-6 — per-space LoroDoc snapshot table.
--
-- Today's `LoroEngineRegistry` is a `Mutex<HashMap<SpaceId, LoroEngine>>`
-- initialised lazily — every restart loses the in-memory engine state and
-- re-derives it from scratch when the next op arrives.  For shadow mode
-- this is fine (the parity sampler doesn't depend on long-lived engine
-- state).  For Phase-2 cutover the engine becomes authoritative — losing
-- engine state across restart is unacceptable.
--
-- Q4 from `pending/PEND-09-crdt-migration.md`, day-6 spec from
-- `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §3 / Gate 6 / §8.1: store the
-- per-space `LoroDoc` as a snapshot blob; rehydrate on app boot;
-- periodically snapshot in the background.
--
-- ## Columns
--
-- - `space_id`   — primary key (one snapshot per space; INSERT OR REPLACE
--                  on every save).  Mirrors the per-space-doc design from
--                  SPIKE-REPORT.md §4.1.
-- - `snapshot`   — opaque bytes from `LoroEngine::export_snapshot()`
--                  (`ExportMode::Snapshot`).  Sized in low MiB at typical
--                  workspace scales (SPIKE-REPORT.md §3 Plan 3 measured
--                  ≈ 6.4 MiB at 25K alive blocks; ≈ 26 MiB extrapolated
--                  to 100K).  SQLite-blob storage is unproblematic.
-- - `updated_at` — wall-clock ms-since-Unix-epoch of the last save.
--                  Indexed so the scheduler can find the staleness frontier
--                  quickly and a future "snapshots older than X" query can
--                  range-scan instead of full-scan.
-- - `op_count`   — number of ops since the last snapshot was taken.
--                  Reset to 0 on every save.  Currently unused by the day-6
--                  scheduler (which is purely time-driven), but reserved
--                  for a future "snapshot every N ops" cadence per §8.1
--                  option (a).
--
-- ## STRICT
--
-- New table, so STRICT applies (PEND-07 policy).  All columns have explicit
-- types; no INTEGER affinity tricks.

CREATE TABLE loro_doc_state (
    space_id    TEXT PRIMARY KEY NOT NULL,
    snapshot    BLOB NOT NULL,
    updated_at  INTEGER NOT NULL,
    op_count    INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Index for the future "snapshots older than X" / "staleness frontier"
-- queries the scheduler may grow into.  Cheap on a per-space-row table
-- (cardinality bounded by the user's space count).
CREATE INDEX idx_loro_doc_state_updated_at ON loro_doc_state (updated_at);
