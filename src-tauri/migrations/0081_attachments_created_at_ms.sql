-- Issue #109 Phase 2 (cluster): migrate `attachments.created_at` from TEXT
-- (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC). Maintainer
-- decision 2026-05-29: hard cutover. Flips alongside the snapshot format
-- (`AttachmentSnapshot`). `created_at` is sourced from the originating op's
-- `created_at` at materialization time, so it moves with `op_log.created_at`
-- (0079).
--
-- `deleted_at` stays TEXT for now — it is NOT in the #109 inventory's named
-- column set and is a separate (also-nullable) column; leaving it untouched
-- keeps this migration scoped to `created_at`. The partial unique index
-- `WHERE deleted_at IS NULL` is unaffected (IS NULL is type-agnostic).
--
-- Rebuild recipe (precedent 0073). Table is already STRICT; FK
-- `block_id REFERENCES blocks(id) ON DELETE CASCADE` and both indexes
-- (idx_attachments_block, the partial idx_attachments_fs_path_unique) are
-- preserved. Backfill via the ms-precise julianday formula.

CREATE TABLE _new_attachments (
    id          TEXT PRIMARY KEY NOT NULL,
    block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    mime_type   TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    fs_path     TEXT NOT NULL,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    created_at  INTEGER NOT NULL CHECK (created_at >= 0),
    deleted_at  TEXT
) STRICT;

INSERT INTO _new_attachments
    (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at)
    SELECT id, block_id, mime_type, filename, size_bytes, fs_path,
           CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000.0) AS INTEGER),
           deleted_at
    FROM attachments;

DROP TABLE attachments;
ALTER TABLE _new_attachments RENAME TO attachments;

CREATE INDEX idx_attachments_block ON attachments(block_id);
CREATE UNIQUE INDEX idx_attachments_fs_path_unique
    ON attachments(fs_path) WHERE deleted_at IS NULL;
