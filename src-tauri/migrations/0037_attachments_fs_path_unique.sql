-- M-30 (REVIEW-LATER.md): enforce uniqueness of `attachments.fs_path` so
-- two `add_attachment` calls with the same `fs_path` can no longer succeed
-- silently and produce two rows pointing at the same on-disk file. Without
-- this guard, once `delete_attachment` actually unlinks the file (C-3a/b,
-- already shipped), deleting one of the two rows would clobber the other
-- row's content.
--
-- Design: PARTIAL unique index restricted to non-soft-deleted rows
-- (`WHERE deleted_at IS NULL`). The `attachments.deleted_at` column exists
-- in the initial schema (see `0001_initial.sql`) for a future soft-delete
-- path; today's `delete_attachment_inner` and the materializer's
-- `DeleteAttachment` handler both hard-delete (DELETE FROM attachments),
-- so in production every surviving row already satisfies
-- `deleted_at IS NULL` and the partial predicate is effectively a full
-- unique index. The partial form is forward-compatible: if/when soft-delete
-- ships for attachments, a tombstone row with `deleted_at` set must NOT
-- block a fresh insert at the same `fs_path` (e.g. user deletes a file
-- and re-adds it at the same path).
--
-- Migration risk: this CREATE will FAIL on any existing user DB that
-- contains two non-soft-deleted rows with the same `fs_path`. Per
-- AGENTS.md the threat model is single-user / maintainer-only at this
-- stage; if this migration fails on a real DB, the maintainer must
-- reconcile the duplicates by hand (pick a winner, hard-delete the rest)
-- before retrying. We intentionally do not ship a data-fixup step
-- because (a) collisions are not expected in normal flow given the
-- ULID-in-path convention, and (b) automatic dedup would risk losing
-- user data without consent.

CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_fs_path_unique
    ON attachments(fs_path)
    WHERE deleted_at IS NULL;
