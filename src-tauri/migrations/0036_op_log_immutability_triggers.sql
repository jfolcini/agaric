-- H-13 — Database-level enforcement of AGENTS.md invariant #1:
--   "Op log is strictly append-only — never mutate, never delete (except
--   compaction)."
--
-- Adds BEFORE UPDATE / BEFORE DELETE triggers on `op_log` that ABORT unless
-- a bypass sentinel row is present in `_op_log_mutation_allowed`. The
-- compaction code path (`snapshot::compact_op_log` and the equivalent
-- snapshot-driven RESET in `snapshot::apply_snapshot`) toggles the sentinel
-- via the helper pair in `op_log.rs`:
--
--     enable_op_log_mutation_bypass(conn)   // INSERT sentinel row
--     ... UPDATE/DELETE op_log ...
--     disable_op_log_mutation_bypass(conn)  // DELETE sentinel row
--
-- Connection scoping
-- ------------------
-- The H-13 spec called for a `temp.` prefix to scope the sentinel to a
-- single connection. SQLite forbids triggers from referencing objects in
-- another database (including the per-connection `temp` schema), so a
-- `temp._op_log_mutation_allowed` reference is rejected at trigger-creation
-- time with "trigger ... cannot reference objects in database temp".
--
-- We achieve equivalent isolation via transactional discipline instead of
-- physical-schema scoping: the helper INSERTs the sentinel inside the
-- caller's `BEGIN IMMEDIATE` write transaction and the helper requires the
-- sentinel be DELETEd before the same transaction commits. Because the
-- writer holds SQLite's exclusive write lock for the duration, and because
-- WAL readers never see uncommitted writes from other connections, sibling
-- connections never observe the sentinel as present — equivalent to
-- per-connection scoping for any well-formed compaction tx. The
-- `compaction_bypass_does_not_leak_to_sibling_connection` test asserts
-- this property end-to-end.

CREATE TABLE IF NOT EXISTS _op_log_mutation_allowed (
    token INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS op_log_no_update
BEFORE UPDATE ON op_log
WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)
BEGIN
    SELECT RAISE(ABORT, 'op_log is append-only; UPDATE forbidden outside compaction');
END;

CREATE TRIGGER IF NOT EXISTS op_log_no_delete
BEFORE DELETE ON op_log
WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)
BEGIN
    SELECT RAISE(ABORT, 'op_log is append-only; DELETE forbidden outside compaction');
END;
