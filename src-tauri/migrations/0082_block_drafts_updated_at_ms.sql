-- Issue #109 Phase 2 (cluster): migrate `block_drafts.updated_at` from TEXT
-- (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC). Maintainer
-- decision 2026-05-29: hard cutover.
--
-- `block_drafts` is device-local (never synced/snapshotted), but it is
-- coupled to `op_log.created_at` via recovery's
-- `… AND created_at > ?` bind of `draft.updated_at`
-- (`recovery/draft_recovery.rs`). With `op_log.created_at` now INTEGER (0079),
-- `updated_at` must also be INTEGER so that cross-table comparison stays a
-- like-typed numeric compare (SQLite ranks INTEGER < TEXT by storage class
-- otherwise) — so it migrates in the same PR.
--
-- Rebuild recipe (precedent 0038/0061). Promotes to STRICT
-- (migrations/AGENTS.md); FK `block_id REFERENCES blocks(id) ON DELETE
-- CASCADE` and the PRIMARY KEY are preserved (no extra indexes). Backfill via
-- the ms-precise julianday formula.

CREATE TABLE _new_block_drafts (
    block_id   TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO _new_block_drafts (block_id, content, updated_at)
    SELECT block_id, content,
           CAST(ROUND((julianday(updated_at) - 2440587.5) * 86400000.0) AS INTEGER)
    FROM block_drafts;

DROP TABLE block_drafts;
ALTER TABLE _new_block_drafts RENAME TO block_drafts;
