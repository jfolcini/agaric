-- Add 'ref' to property_definitions.value_type CHECK constraint.
-- SQLite does not support ALTER TABLE ... ALTER CONSTRAINT, so we recreate.
CREATE TABLE property_definitions_new (
    key TEXT PRIMARY KEY NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref')),
    options TEXT,
    created_at TEXT NOT NULL
);

INSERT INTO property_definitions_new (key, value_type, options, created_at)
    SELECT key, value_type, options, created_at FROM property_definitions;

DROP TABLE property_definitions;

ALTER TABLE property_definitions_new RENAME TO property_definitions;
