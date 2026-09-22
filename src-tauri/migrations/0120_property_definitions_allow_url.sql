-- #4710. Allow 'url' in property_definitions.value_type. A url is stored as a
-- text value (`block_properties.value_text`); the declaration only tells the
-- frontend to render it as a link. SQLite cannot ALTER a CHECK in place, so
-- the table is recreated preserving data, the same shape as 0043 (which first
-- made it STRICT). Nothing references property_definitions by FK, so the DROP
-- cascades into nothing.
CREATE TABLE _new_property_definitions (
    key TEXT PRIMARY KEY NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref', 'boolean', 'url')),
    options TEXT,
    created_at TEXT NOT NULL
) STRICT;

INSERT INTO _new_property_definitions (key, value_type, options, created_at)
    SELECT key, value_type, options, created_at FROM property_definitions;

DROP TABLE property_definitions;
ALTER TABLE _new_property_definitions RENAME TO property_definitions;
