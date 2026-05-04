-- Allow 'boolean' in property_definitions.value_type CHECK constraint (PEND-14).
-- SQLite cannot ALTER CHECK in place; recreate the table preserving data.
--
-- This recreate also retypes property_definitions to STRICT mode (PEND-07
-- policy). The original table (created in migration 0011, last touched by
-- 0019 to allow 'ref') was non-STRICT; making the recreate STRICT is a
-- beneficial side effect that aligns the table with the policy floor at
-- migration 0042+. Column types (TEXT) are STRICT-compatible.
CREATE TABLE property_definitions_new (
    key TEXT PRIMARY KEY NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref', 'boolean')),
    options TEXT,
    created_at TEXT NOT NULL
) STRICT;

INSERT INTO property_definitions_new (key, value_type, options, created_at)
    SELECT key, value_type, options, created_at FROM property_definitions;

DROP TABLE property_definitions;
ALTER TABLE property_definitions_new RENAME TO property_definitions;
