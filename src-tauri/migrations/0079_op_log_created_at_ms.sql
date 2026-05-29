-- Issue #109 Phase 2 (cluster): migrate `op_log.created_at` from TEXT
-- (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC). Maintainer
-- decision 2026-05-29: hard cutover (all devices upgrade together; no
-- cross-version sync / persisted-snapshot back-compat). This flips the
-- wire format (`OpTransfer`) and the snapshot op rows alongside the column.
--
-- op_log is the append-only event log. The two immutability triggers
-- (migration 0036) forbid UPDATE/DELETE outside compaction. This rebuild
-- does NOT trip them: `INSERT … SELECT` writes the NEW table and reads the
-- old (no UPDATE/DELETE on op_log), and `DROP TABLE` is DDL (triggers don't
-- fire on DROP). The triggers are dropped with the old table and recreated
-- verbatim on the renamed table.
--
-- Rebuild recipe (precedent 0073). Promotes the table to STRICT
-- (migrations/AGENTS.md; all columns are TEXT/INTEGER). The 3 indexes
-- (idx_op_log_created on created_at, idx_op_log_block_id, the partial
-- idx_op_log_attachment_id) and the PRIMARY KEY (device_id, seq) are
-- preserved. Backfill via the ms-precise julianday formula.

CREATE TABLE _new_op_log (
    device_id     TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    parent_seqs   TEXT,
    hash          TEXT NOT NULL,
    op_type       TEXT NOT NULL,
    payload       TEXT NOT NULL,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    created_at    INTEGER NOT NULL CHECK (created_at >= 0),
    block_id      TEXT,
    origin        TEXT NOT NULL DEFAULT 'user',
    attachment_id TEXT,
    PRIMARY KEY (device_id, seq)
) STRICT;

INSERT INTO _new_op_log
    (device_id, seq, parent_seqs, hash, op_type, payload, created_at,
     block_id, origin, attachment_id)
    SELECT device_id, seq, parent_seqs, hash, op_type, payload,
           CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000.0) AS INTEGER),
           block_id, origin, attachment_id
    FROM op_log;

DROP TABLE op_log;
ALTER TABLE _new_op_log RENAME TO op_log;

-- Recreate the 3 indexes (0001 / 0036-era / 0064).
CREATE INDEX idx_op_log_created ON op_log(created_at);
CREATE INDEX idx_op_log_block_id ON op_log(block_id);
CREATE INDEX idx_op_log_attachment_id
    ON op_log (attachment_id)
    WHERE attachment_id IS NOT NULL;

-- Recreate the migration-0036 append-only immutability triggers verbatim.
-- The RAISE messages are preserved character-for-character (tests pin them).
CREATE TRIGGER op_log_no_update
BEFORE UPDATE ON op_log
WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)
BEGIN
    SELECT RAISE(ABORT, 'op_log is append-only; UPDATE forbidden outside compaction');
END;

CREATE TRIGGER op_log_no_delete
BEFORE DELETE ON op_log
WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)
BEGIN
    SELECT RAISE(ABORT, 'op_log is append-only; DELETE forbidden outside compaction');
END;
