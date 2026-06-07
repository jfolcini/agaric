-- Issue #534: the four "fixed" properties `todo_state`, `priority`, `due_date`,
-- `scheduled_date` are column-backed on `blocks` (indexed access) and projected
-- there from Loro via the `is_reserved_property_key()` gate in `src/op.rs`;
-- `space` is likewise column-backed (`blocks.space_id`, #533). For these keys
-- the `blocks` column is the single SQL source of truth and a `block_properties`
-- row would be a stale, unread shadow.
--
-- The gate today is a runtime `match` in `project_set_property_to_sql` /
-- `set_property_in_tx` / the op-log recovery replay. The risk #534 flags: a
-- future code path (or a new reserved key added to the op layer but not to the
-- routing) could `INSERT` one of these keys into `block_properties`, silently
-- diverging from the column with no compile-time or test-time signal.
--
-- This migration promotes that convention into a storage-layer invariant: a
-- `CHECK (key NOT IN (...))` on `block_properties`. CHECK over a trigger
-- deliberately follows the precedent set by migration 0085, which promoted the
-- `block_type` guard from triggers to a CHECK precisely because triggers must
-- be re-created on every table rebuild (a missed recreation silently drops the
-- guard) whereas a CHECK survives rebuilds automatically. `block_properties` is
-- rebuilt periodically (0061 FK-cascade, 0062 exactly_one_value), so that
-- per-rebuild vigilance tax applies here too.
--
-- SQLite has no `ALTER TABLE ... ADD CHECK`, so this uses the canonical table
-- rebuild (in-repo precedent: 0062 on this very table, 0085 on `blocks`).
-- Nothing FK-*references* `block_properties`, so the DROP/RENAME needs no
-- inbound-FK re-resolution; its own outbound FKs to `blocks` re-resolve by name
-- at the migration tx's commit. The copy drops any pre-existing reserved/space
-- rows (defensive cleanup — production never writes them, but legacy op-log
-- replays or old builds might have).

CREATE TABLE _new_block_properties (
    block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_text TEXT,
    value_num  REAL,
    value_date TEXT,
    value_ref  TEXT REFERENCES blocks(id) ON DELETE CASCADE,
    value_bool INTEGER CHECK (value_bool IS NULL OR value_bool IN (0, 1)),
    PRIMARY KEY (block_id, key),
    CONSTRAINT exactly_one_value CHECK (
        ((value_text IS NOT NULL)
       + (value_num  IS NOT NULL)
       + (value_date IS NOT NULL)
       + (value_ref  IS NOT NULL)
       + (value_bool IS NOT NULL)) = 1
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
FROM block_properties
WHERE key NOT IN ('todo_state', 'priority', 'due_date', 'scheduled_date', 'space');

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
