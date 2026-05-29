-- Issue #109 Phase 2: migrate `peer_refs.synced_at` and
-- `peer_refs.last_reset_at` from TEXT (RFC 3339) to INTEGER
-- milliseconds-since-UNIX-epoch (UTC), the canonical timestamp encoding
-- (Phase 1 / migrations/AGENTS.md; written via `crate::db::now_ms()`).
--
-- `peer_refs` is genuinely independent of the `op_log.created_at` timestamp
-- cluster: both columns are self-generated (`now_rfc3339()` at the sync /
-- reset write sites) and only ever compared in Rust (`sync_scheduler.rs`
-- parses `synced_at` and diffs against `now`), never in a cross-table SQL
-- predicate. So it migrates standalone with no coupling risk.
--
-- Both columns are NULLABLE (a peer that has never synced / reset). The new
-- columns keep that nullability and add `CHECK (col IS NULL OR col >= 0)`.
-- SQLite has no `ALTER COLUMN`, so this uses the canonical table-rebuild
-- recipe (precedent 0061/0062/0073) and promotes the table to `STRICT`
-- (migrations/AGENTS.md). `peer_refs` has no foreign keys, no triggers, and
-- no indexes beyond its `peer_id` PRIMARY KEY.
--
-- Column set (accumulated): 0001 (peer_id, last_hash, last_sent_hash,
-- synced_at, reset_count, last_reset_at) + 0009 (cert_hash) + 0010
-- (device_name) + 0017 (last_address). Order preserved.
--
-- Backfill: `NULL` stays `NULL`; a non-null RFC 3339 string is converted via
-- the `julianday`-based epoch-ms formula (preserves sub-second precision,
-- unlike `strftime('%s')*1000`).

CREATE TABLE _new_peer_refs (
    peer_id        TEXT PRIMARY KEY NOT NULL,
    last_hash      TEXT,
    last_sent_hash TEXT,
    -- milliseconds since UNIX epoch (UTC); NULL = never synced
    synced_at      INTEGER CHECK (synced_at IS NULL OR synced_at >= 0),
    reset_count    INTEGER NOT NULL DEFAULT 0,
    -- milliseconds since UNIX epoch (UTC); NULL = never reset
    last_reset_at  INTEGER CHECK (last_reset_at IS NULL OR last_reset_at >= 0),
    cert_hash      TEXT,
    device_name    TEXT,
    last_address   TEXT
) STRICT;

INSERT INTO _new_peer_refs
    (peer_id, last_hash, last_sent_hash, synced_at, reset_count,
     last_reset_at, cert_hash, device_name, last_address)
    SELECT peer_id, last_hash, last_sent_hash,
           CASE WHEN synced_at IS NULL THEN NULL
                ELSE CAST(ROUND((julianday(synced_at) - 2440587.5) * 86400000.0) AS INTEGER)
           END,
           reset_count,
           CASE WHEN last_reset_at IS NULL THEN NULL
                ELSE CAST(ROUND((julianday(last_reset_at) - 2440587.5) * 86400000.0) AS INTEGER)
           END,
           cert_hash, device_name, last_address
    FROM peer_refs;

DROP TABLE peer_refs;
ALTER TABLE _new_peer_refs RENAME TO peer_refs;
