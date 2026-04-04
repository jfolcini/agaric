-- Remove dead archived_at column (never written to, always NULL).
ALTER TABLE blocks DROP COLUMN archived_at;
