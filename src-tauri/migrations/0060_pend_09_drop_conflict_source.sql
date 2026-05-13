-- PEND-09 Phase 5: drop the `blocks.conflict_source` column. This FK
-- column was a back-pointer from a conflict-copy row to the block it
-- branched from. The conflict-copy mechanism was retired when Loro
-- CRDT became the single op-application path, so the column is dead
-- weight: every value is NULL and no code reads it for behavior. The
-- snapshot wire format also drops the field (SCHEMA_VERSION bumps to
-- 4) because the column no longer exists to round-trip.
ALTER TABLE blocks DROP COLUMN conflict_source;
