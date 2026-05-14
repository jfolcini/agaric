-- SQL-review 2026-05-14 §1 B-4: add extracted attachment_id column + index
-- for O(log N) reverse-attachment lookups instead of a linear JSON scan.
--
-- Rationale: `reverse::attachment_ops::reverse_delete_attachment` previously
-- used `json_extract(payload, '$.attachment_id') = ?` filtered by
-- `op_type = 'add_attachment'`. With 5K attachments in op_log, every
-- delete_attachment undo full-scanned those rows (no covering index on the
-- json_extract expression). By extracting attachment_id into a dedicated
-- column populated on insert (see `op_log.rs` `OpPayload::attachment_id()`
-- and `extract_attachment_id_from_payload`), we can index it and make
-- attachment-scoped op_log lookups O(log N).
--
-- This mirrors the proven `op_log.block_id` denormalisation pattern from
-- migration 0030 (add column + backfill + index). Unlike the block_id
-- rollout, there is no legacy expression index to drop in a follow-up
-- migration — the previous attachment_id lookup was an unindexed
-- json_extract scan, not an indexed expression — so this is a single
-- additive migration with no companion drop.
--
-- This is additive: the op log invariant (strictly append-only) is
-- preserved. No op semantics change — we only add a redundant, derivable
-- index column. `op_log` is non-STRICT (created pre-PEND-07 in migration
-- 0001); `ALTER TABLE ... ADD COLUMN TEXT` is unconditionally allowed
-- (nullable TEXT defaulting to NULL).
--
-- ## H-13 bypass
--
-- Migration 0036 installed BEFORE UPDATE / BEFORE DELETE triggers on
-- `op_log` that ABORT unless a sentinel row exists in
-- `_op_log_mutation_allowed`. The backfill UPDATE below would otherwise
-- fail. sqlx wraps each migration in its own transaction, so we INSERT
-- the sentinel, run the UPDATE, and DELETE the sentinel before commit —
-- exactly the pattern used by `op_log::{enable,disable}_op_log_mutation_bypass`.
-- The sentinel is never visible to sibling connections because the
-- migration writer holds SQLite's exclusive write lock for the duration
-- and the row is removed before commit.

ALTER TABLE op_log ADD COLUMN attachment_id TEXT;

-- Backfill from existing rows. One-time cost at migration time; future
-- inserts populate attachment_id directly via the Rust typed OpPayload
-- enum. Only `add_attachment` and `delete_attachment` op types carry an
-- `attachment_id` field in their payload (every other variant identifies
-- its target by `block_id`).
INSERT INTO _op_log_mutation_allowed (token) VALUES (1);

UPDATE op_log
SET attachment_id = json_extract(payload, '$.attachment_id')
WHERE op_type IN ('add_attachment', 'delete_attachment')
  AND attachment_id IS NULL;

DELETE FROM _op_log_mutation_allowed;

CREATE INDEX IF NOT EXISTS idx_op_log_attachment_id
    ON op_log (attachment_id)
    WHERE attachment_id IS NOT NULL;
