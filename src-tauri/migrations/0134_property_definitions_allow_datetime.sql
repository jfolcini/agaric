-- #6758. Allow 'datetime' in property_definitions.value_type. A datetime is
-- an instant, stored in UTC as `YYYY-MM-DDTHH:MMZ` in
-- `block_properties.value_date`. SQLite cannot ALTER a CHECK in place, so the
-- table is recreated preserving data, as 0120 did for 'url'. Nothing
-- references property_definitions by FK, so the DROP cascades into nothing,
-- and the table has no index or trigger to create again.
--
-- This migration ships with engine format 8: a build that predates it refuses
-- the vault at the migration check instead of reading a definition whose type
-- it does not know.
CREATE TABLE _new_property_definitions (
    space_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref', 'boolean', 'url', 'datetime')),
    options TEXT,
    created_at TEXT NOT NULL,
    multiple INTEGER NOT NULL DEFAULT 0 CHECK (multiple IN (0, 1)),
    PRIMARY KEY (space_id, key)
) STRICT;

INSERT INTO _new_property_definitions (space_id, key, value_type, options, created_at, multiple)
    SELECT space_id, key, value_type, options, created_at, multiple FROM property_definitions;

DROP TABLE property_definitions;
ALTER TABLE _new_property_definitions RENAME TO property_definitions;
