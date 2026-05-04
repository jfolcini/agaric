-- Add native boolean column to block_properties (PEND-14).
-- SQLite stores booleans as INTEGER. CHECK constraint keeps it strictly
-- (0, 1, NULL) — null means "no boolean value", not "false".
-- Requires SQLite 3.37+ for the ALTER TABLE ... ADD COLUMN ... CHECK syntax;
-- the repo's pinned sqlx 0.8.6 bundles a SQLite well above this version.
ALTER TABLE block_properties ADD COLUMN value_bool INTEGER
  CHECK (value_bool IS NULL OR value_bool IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_block_properties_value_bool
  ON block_properties(value_bool)
  WHERE value_bool IS NOT NULL;
