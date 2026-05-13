-- PEND-09 Phase 5 — drop the residual `conflict_type` column from `blocks`.
--
-- The column is unwritable post-Phase-3-day-7 (commit 6ffcefe7): the
-- diffy three-way merge that was the only writer of `conflict_type`
-- values has been deleted, the Loro CRDT engine is the single
-- op-application path, and Phase 4 dropped the sibling `is_conflict`
-- column.  Session 700 (this commit) drops the conflict-management
-- IPCs, frontend views, and Rust struct fields; this migration closes
-- the schema-residue audit trail.
--
-- There is no index on `conflict_type` (none was ever added), so no
-- `DROP INDEX` is needed.

ALTER TABLE blocks DROP COLUMN conflict_type;
