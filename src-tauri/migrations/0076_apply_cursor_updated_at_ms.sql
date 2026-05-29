-- Issue #109 Phase 2: migrate `materializer_apply_cursor.updated_at` from
-- TEXT (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC), the
-- canonical timestamp encoding (Phase 1 / migrations/AGENTS.md; written via
-- `crate::db::now_ms()`).
--
-- This is a single-row bookkeeping table (`id = 1`, CHECK-enforced) whose
-- `updated_at` is **write-only**: every reader selects only
-- `materialized_through_seq`, so the column is never compared or returned —
-- fully independent of the `op_log.created_at` cluster. Picked next per the
-- least-hot-first ordering after `link_metadata` (0074) and `peer_refs`
-- (0075).
--
-- SQLite has no `ALTER COLUMN`, so this uses the canonical table-rebuild
-- recipe (precedent 0061/0062/0073) and promotes the table to `STRICT`
-- (migrations/AGENTS.md). The `id = 1` CHECK and the `materialized_through_seq`
-- default are preserved. Backfill converts the single row's RFC 3339 value
-- via the `julianday`-based epoch-ms formula (ms-precise).

CREATE TABLE _new_materializer_apply_cursor (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    materialized_through_seq INTEGER NOT NULL DEFAULT 0,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO _new_materializer_apply_cursor (id, materialized_through_seq, updated_at)
    SELECT id, materialized_through_seq,
           CAST(ROUND((julianday(updated_at) - 2440587.5) * 86400000.0) AS INTEGER)
    FROM materializer_apply_cursor;

DROP TABLE materializer_apply_cursor;
ALTER TABLE _new_materializer_apply_cursor RENAME TO materializer_apply_cursor;
