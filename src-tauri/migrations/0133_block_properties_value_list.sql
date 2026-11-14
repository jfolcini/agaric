-- Issue #6741: a property can hold a list. The list is one value in the one
-- row `(block_id, key)`: a sixth value column, `value_list`, holding a
-- non-empty JSON array of strings or numbers, and a definition says its key
-- holds one with `property_definitions.multiple`.
--
-- `exactly_one_value` counts the value columns, and SQLite cannot alter a
-- CHECK in place, so the column needs the table rebuilt (as 0062 and 0088
-- rebuilt it). Nothing references `block_properties` by foreign key, so the
-- DROP cascades into nothing; its own foreign keys to `blocks` re-resolve by
-- name. The DROP also removes the table's indexes and the trigger 0089 put on
-- it, `spaces_register_is_space`, so both are created again below.
--
-- This migration ships with engine format 7: a build that predates it refuses
-- the vault at the migration check instead of reading a list it cannot project.

CREATE TABLE _new_block_properties (
    block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_text TEXT,
    value_num  REAL,
    value_date TEXT,
    value_ref  TEXT REFERENCES blocks(id) ON DELETE CASCADE,
    value_bool INTEGER CHECK (value_bool IS NULL OR value_bool IN (0, 1)),
    value_list TEXT CHECK (
        value_list IS NULL
        OR (json_valid(value_list)
            AND json_type(value_list) = 'array'
            AND json_array_length(value_list) > 0)
    ),
    PRIMARY KEY (block_id, key),
    CONSTRAINT exactly_one_value CHECK (
        ((value_text IS NOT NULL)
       + (value_num  IS NOT NULL)
       + (value_date IS NOT NULL)
       + (value_ref  IS NOT NULL)
       + (value_bool IS NOT NULL)
       + (value_list IS NOT NULL)) = 1
    ),
    -- #534: reserved/fixed properties live in their dedicated `blocks` column,
    -- never as a property row. Keep this list in sync with
    -- `is_reserved_property_key()` (the four) plus `space` (#533).
    CONSTRAINT key_not_reserved CHECK (
        key NOT IN ('todo_state', 'priority', 'due_date', 'scheduled_date', 'space')
    )
) STRICT;

INSERT INTO _new_block_properties
    (block_id, key, value_text, value_num, value_date, value_ref, value_bool)
SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool
FROM block_properties;

DROP TABLE block_properties;

ALTER TABLE _new_block_properties RENAME TO block_properties;

CREATE INDEX idx_block_props_key
    ON block_properties(key, block_id);
CREATE INDEX idx_block_props_key_text
    ON block_properties(key, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX idx_block_props_date
    ON block_properties(value_date) WHERE value_date IS NOT NULL;
CREATE INDEX idx_block_properties_key_value_num
    ON block_properties(key, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX idx_block_properties_value_bool
    ON block_properties(value_bool) WHERE value_bool IS NOT NULL;
CREATE INDEX idx_block_properties_value_ref
    ON block_properties(value_ref) WHERE value_ref IS NOT NULL;

-- 0089's trigger, unchanged: an `is_space = 'true'` row registers its block
-- as a space. Idempotency is in `WHEN`, not `INSERT OR IGNORE` (see 0089).
CREATE TRIGGER spaces_register_is_space
AFTER INSERT ON block_properties
WHEN NEW.key = 'is_space' AND NEW.value_text = 'true'
     AND NOT EXISTS (SELECT 1 FROM spaces WHERE id = NEW.block_id)
BEGIN
    INSERT INTO spaces (id) VALUES (NEW.block_id);
END;

ALTER TABLE property_definitions
    ADD COLUMN multiple INTEGER NOT NULL DEFAULT 0 CHECK (multiple IN (0, 1));
