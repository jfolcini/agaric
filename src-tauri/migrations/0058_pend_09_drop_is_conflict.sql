-- PEND-09 Phase 4 — drop the `is_conflict` column from `blocks`.
--
-- Rationale: Phase 3 (commits `6ffcefe7` and `99e43ce7`) made the
-- conflict-copy creation path unreachable.  No new rows have
-- `is_conflict = 1` written to them post-Phase-3.  The column was
-- read from ~670 sites as `WHERE is_conflict = 0` filter clauses;
-- those filter clauses are now vacuous (every row has
-- `is_conflict = 0`) and the surrounding sweep removes them.
--
-- The partial index `idx_blocks_conflict` (added in 0049) is dropped
-- alongside the column — SQLite cannot keep an index on a column
-- that no longer exists.
--
-- The sibling `conflict_type` column is NOT dropped: legacy
-- conflict-copy rows in user databases may still carry historical
-- `conflict_type` values, and they're harmless residue.

DROP INDEX IF EXISTS idx_blocks_conflict;
ALTER TABLE blocks DROP COLUMN is_conflict;
