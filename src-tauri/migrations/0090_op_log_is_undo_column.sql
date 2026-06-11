-- #659: add `is_undo` provenance flag to op_log.
--
-- `redo_page_op` reverses "the undo op the caller hands it" — but until now
-- it never verified that the referenced op actually WAS an undo op. A buggy
-- (or malicious) IPC caller could pass any forward op ref and have it
-- reversed, labelled `is_redo: true`. The reverse op a redo produces is
-- indistinguishable in op_log from a forward op of the same type, so the
-- provenance must be recorded at append time.
--
-- `is_undo = 1` is stamped by `undo_page_op_inner` (via
-- `op_log::append_local_undo_op_in_tx`) on the reverse op it appends;
-- everything else — forward command ops, redo-produced ops (which are
-- forward-equivalent), remote sync inserts, recovery synthetics — keeps the
-- default 0. `redo_page_op_inner` then rejects a target whose `is_undo` is 0.
--
-- Backward compatibility: undo ops appended BEFORE this migration backfill
-- to 0, so they are no longer redoable. Redo targets are session-scoped in
-- the frontend (the redo stack does not survive a restart, let alone an app
-- upgrade), so no live redo ref can point at a pre-migration undo op.
--
-- Like `origin` (migration 0033), `is_undo` is local metadata and is
-- intentionally NOT part of `compute_op_hash`'s preimage — two devices
-- holding the same logical op must hash-match regardless of how the op was
-- produced locally. The op-log immutability triggers (0036) are unaffected:
-- the flag is set on INSERT, never via UPDATE.

ALTER TABLE op_log
    ADD COLUMN is_undo INTEGER NOT NULL DEFAULT 0;
