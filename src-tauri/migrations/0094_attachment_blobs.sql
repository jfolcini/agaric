-- Issue #1993 Phase 1: content-addressed attachment blob store (local dedup).
--
-- ## Problem
--
-- Before this migration the storage model was one `attachments` row per
-- owning block AND one on-disk file per row (at `app_data_dir/<fs_path>`).
-- Identical bytes referenced by N blocks therefore cost N rows + N copies on
-- disk. Migration 0093 persists a blake3 `content_hash` per row but does not
-- USE it for dedup.
--
-- ## Shape chosen
--
-- A content-addressed blob store owns the BYTES; the per-block `attachments`
-- row owns the *reference*:
--
--   attachment_blobs(content_hash PK, on_disk_path UNIQUE, size_bytes, created_at)
--
-- * The link from an `attachments` row to its blob is the **already-existing**
--   `attachments.content_hash` column (0093). No new FK column is added —
--   keeping the wire ops (`AddAttachment` carries `fs_path`, not a blob id),
--   the snapshot format, and the sync layer unchanged. The blob is found by
--   hash on demand.
-- * `attachments.fs_path` is RETAINED and, after dedup, points at the
--   canonical blob's `on_disk_path`. So every read path
--   (`read_attachment_inner` → `fs_path`), the sync sender
--   (`receive_request_and_send_files` → `fs_path`), and the GC walker keep
--   working byte-for-byte. Many `attachments` rows may now share one
--   `fs_path` (= one blob file).
--
-- ## Broken assumption fixed here (#1993 scoping item 1)
--
-- The partial UNIQUE index `idx_attachments_fs_path_unique` (0037, rebuilt in
-- 0061/0081) forbade two live rows sharing one `fs_path` — which is exactly
-- what dedup REQUIRES (many rows → one blob file). We DROP it. The integrity
-- it provided (a delete of one row must not clobber another row's bytes) is
-- now provided by the blob layer: byte-unlink is refcount-aware in the GC pass
-- (`cleanup_orphaned_attachments`) and the per-row delete/cascade no longer
-- unlinks bytes a sibling row still references.
--
-- ## Backfill
--
-- SQLite cannot compute blake3, so the byte→blob backfill is a Rust boot-time
-- pass (`recovery::attachment_blob_backfill::backfill_attachment_blobs`),
-- which runs AFTER 0093's hash backfill. It does not hash anything itself: it
-- groups live `attachments` by their EXISTING `content_hash` (skipping rows
-- still NULL — the prior 0093 pass already hashed everything whose file it
-- could read), creates one `attachment_blobs` row per distinct hash pointing
-- at one surviving file, and repoints duplicate rows' `fs_path` at that
-- canonical file. This migration only creates the (empty) table + drops the
-- index.
--
-- Append-only (#806): NEW migration file; no existing migration is edited.

CREATE TABLE attachment_blobs (
    -- blake3 hex digest of the file bytes. Same scheme as 0093's
    -- `attachments.content_hash` and the sync `FileOffer.blake3_hash`, so a
    -- blob's key matches a row's `content_hash` byte-for-byte.
    content_hash TEXT NOT NULL PRIMARY KEY,
    -- Relative, forward-slash path under `app_data_dir` (same shape as
    -- `attachments.fs_path`). UNIQUE: one canonical file per blob.
    on_disk_path TEXT NOT NULL UNIQUE,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
    -- milliseconds since the UNIX epoch (UTC); written via crate::db::now_ms().
    created_at   INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

-- Drop the fs_path UNIQUE index so many attachment rows can share one blob
-- file. Reference integrity is now handled by the blob layer + refcount-aware
-- GC, not by forbidding shared paths.
DROP INDEX IF EXISTS idx_attachments_fs_path_unique;
