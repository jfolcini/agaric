-- #5841 S0.5 — property definitions are per space, keyed `(space_id, key)`.
-- The built-ins are code constants (0128) and have no rows.
--
-- Every existing definition is copied into every registered space, trashed
-- ones included (`spaces` keeps a soft-deleted space's row), so each space
-- starts with the declarations the vault had. A vault with no space yet (a
-- fresh one: the spaces bootstrap runs after the migrations) keeps no rows;
-- the bootstrap gives Personal and Work the default definitions when it
-- creates them.
--
-- `space_id` has no foreign key, as `tags_cache.space_id`: a `spaces` or
-- `blocks` rebuild deletes and restores the registry rows, and a CASCADE would
-- take the definitions with them. A space purge deletes its rows itself.
-- Nothing references `property_definitions` by FK, so the DROP cascades into
-- nothing.
CREATE TABLE _new_property_definitions (
    space_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref', 'boolean', 'url')),
    options TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (space_id, key)
) STRICT;

INSERT INTO _new_property_definitions (space_id, key, value_type, options, created_at)
    SELECT s.id, d.key, d.value_type, d.options, d.created_at
      FROM spaces s
     CROSS JOIN property_definitions d;

DROP TABLE property_definitions;
ALTER TABLE _new_property_definitions RENAME TO property_definitions;
