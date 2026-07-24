-- #3000 — list-ness as a block attribute.
--
-- List style is stored as a generic block_properties row under the key
-- 'listStyle' (value_text 'bullet' | 'ordered'; absence = 'none'). Register it
-- as a select-type property definition so the property editor knows its value
-- vocabulary. This is a data seed into the existing property_definitions table
-- (migration 0011) — no schema change, no new blocks column. The key is NOT a
-- reserved/column-backed key, so set_property/get_property/delete_property and
-- the op-log/undo/sync paths handle it like any other property.
--
-- INSERT OR IGNORE keeps this idempotent and safe if a user already created a
-- 'listStyle' definition by hand.
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at)
VALUES
    ('listStyle', 'select', '["bullet","ordered"]', '2026-07-24T00:00:00.000Z');
