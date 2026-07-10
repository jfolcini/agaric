-- #2468: record WHICH op a reverse op reverses — `(reverses_device_id,
-- reverses_seq)` — so the ref-addressed interactive undo (`undo_op` /
-- `undo_ops`) can enforce its already-reversed guard.
--
-- Until now the link "reverse op R undoes forward op X" existed only
-- implicitly (R's payload is the computed inverse of X); the positional
-- undo stack never needed it because the frontend's depth accounting was
-- the only bookkeeping. Ref-addressed undo hands the backend an exact
-- `(device_id, seq)` and must reject a ref that is CURRENTLY reversed —
-- otherwise a double-submit (or a stale frontend stack entry) would apply
-- the same inverse twice.
--
-- Stamped by `op_log::append_local_op_in_tx_with_provenance` via:
--   * `append_local_undo_op_in_tx` — every undo-producing path
--     (`undo_page_op`, `undo_page_group`, `undo_op`, `undo_ops`,
--     `revert_ops`, point-in-time restore) stamps the ref of the op whose
--     inverse is being appended;
--   * `append_local_redo_op_in_tx` — redo stamps the ref of the UNDO op it
--     reverses (while keeping `is_undo = 0`, its output being
--     forward-equivalent — see migration 0090).
--
-- "Currently reversed" is therefore: an op X is reversed iff there exists
-- an op U with `U.reverses = X` that is not itself reversed by some later
-- op R with `R.reverses = U`. An undo → redo cycle correctly returns X to
-- the not-reversed state, so a subsequent ref-addressed undo of X is legal.
--
-- Like `origin` (0033), `is_undo` (0090), and `is_replicated` (0099), the
-- pair is LOCAL provenance metadata and intentionally NOT part of
-- `compute_op_hash`'s preimage — two devices holding the same logical op
-- must hash-match regardless of local undo bookkeeping. The op-log
-- immutability triggers (0036) are unaffected: the columns are set on
-- INSERT, never via UPDATE.
--
-- Backward compatibility: rows predating this migration backfill to NULL
-- ("link unknown"). Pre-migration reverse ops therefore don't participate
-- in the already-reversed guard — correct, because the frontend undo/redo
-- stacks are session-scoped and no live ref can point at one.

ALTER TABLE op_log
    ADD COLUMN reverses_device_id TEXT;
ALTER TABLE op_log
    ADD COLUMN reverses_seq INTEGER;

-- Partial index for the guard's EXISTS probes (`WHERE reverses_device_id =
-- ? AND reverses_seq = ?`). Partial on NOT NULL: only reverse ops carry the
-- link, so forward ops (the overwhelming majority) stay out of the index.
CREATE INDEX idx_op_log_reverses
    ON op_log (reverses_device_id, reverses_seq)
    WHERE reverses_device_id IS NOT NULL;
