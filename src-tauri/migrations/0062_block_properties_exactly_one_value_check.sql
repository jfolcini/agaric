-- B-1 (sql-review-2026-05-14): add a row-level CHECK constraint on
-- `block_properties` enforcing that EXACTLY ONE of the five value columns
-- (`value_text`, `value_num`, `value_date`, `value_ref`, `value_bool`) is
-- non-null per row.
--
-- Background / invariant:
--   A `block_properties` row models a single typed property value attached
--   to a block under a given key.  By design exactly one of the typed
--   value columns is populated; the other four are NULL.  This invariant
--   was previously enforced only in Rust by `validate_property_value()`
--   in `src-tauri/src/commands/properties.rs`.  SQLite enforced nothing,
--   so a future feature path that writes outside the command layer (a
--   sync replay of a corrupted op, a direct UPDATE in a migration
--   backfill, a future MCP tool that bypasses the validator) could
--   silently land a row with zero or two non-null value columns and the
--   schema would happily accept it.  Promoting the invariant to a
--   `CHECK` constraint moves the last line of defence from a single
--   Rust callsite to the storage layer itself.
--
-- Why now:
--   Migration 0061 just rebuilt `block_properties` for the FK cascade
--   work, so every index and FK clause for the table is recorded here in
--   one place and there is a precedent table-rebuild we can match.
--   Adding the CHECK now keeps the schema consistent before any future
--   feature (op-log replay rewrites, batched importers, new
--   property-aware MCP tools) starts writing properties through a fresh
--   code path.
--
-- Knock-on FK change — value_ref switches from SET NULL to CASCADE:
--   Migration 0061 declared `value_ref REFERENCES blocks(id) ON DELETE
--   SET NULL`.  The rationale at the time (see 0061 lines 43-49) was
--   that "the property belongs to `block_id`, not `value_ref`" — i.e.
--   a property row could carry other values alongside `value_ref` and
--   nulling the ref would preserve that content.  Under the new
--   exactly-one-value invariant introduced here, a row with `value_ref`
--   set has no other typed value populated.  SET NULL would therefore
--   produce an all-NULL row that immediately violates the new CHECK,
--   causing the cascade itself to fail with a constraint error — every
--   future hard-delete of a referenced block would abort.
--
--   The semantically correct response is `ON DELETE CASCADE` for
--   `value_ref`: once the referenced block is gone the property row has
--   lost its only piece of content and is meaningfully dead.  This is
--   one of the rare cases where adding a CHECK *requires* a paired FK
--   adjustment to keep the schema internally consistent, and the
--   adjustment is the conservative direction (delete the now-empty
--   row, do not try to keep a tombstone).  Application sites that
--   previously `UPDATE block_properties SET value_ref = NULL WHERE
--   value_ref IN (...)` are updated in the same patch to `DELETE FROM
--   block_properties WHERE value_ref IN (...)`.
--
-- Backfill audit:
--   The audit predicate that establishes the invariant on existing data
--   is:
--
--     SELECT COUNT(*) FROM block_properties
--      WHERE ((value_text IS NOT NULL)
--           + (value_num  IS NOT NULL)
--           + (value_date IS NOT NULL)
--           + (value_ref  IS NOT NULL)
--           + (value_bool IS NOT NULL)) != 1
--
--   In SQLite a boolean expression like `value_text IS NOT NULL`
--   coerces to a 0/1 integer; the sum of the five expressions must
--   equal 1 for the row to be valid.  This same arithmetic is the body
--   of the new CHECK constraint, so the audit and the constraint use
--   one identical predicate.
--
--   On a clean database the audit returns 0 and the migration just
--   proceeds.  If, hypothetically, a violating row already exists, the
--   `INSERT INTO _new_block_properties SELECT ... FROM block_properties`
--   step below fails with `CHECK constraint failed: exactly_one_value`,
--   sqlx rolls back the migration's transaction, the old table is left
--   untouched, and the error surfaces to the operator — equivalent to
--   panicking, fail-loud and safe.  (SQLite does not permit top-level
--   `RAISE()` outside of trigger programs, so a pre-INSERT abort
--   statement is not available.  The CHECK on the new table during the
--   bulk copy is the strongest, most direct mechanism the dialect
--   offers and it shares one source-of-truth predicate with the audit
--   query above.)
--
-- Mechanics:
--   SQLite does not support `ALTER TABLE ... ADD CONSTRAINT`, so we use
--   the canonical 12-step table-rebuild recipe from migration 0061
--   (which itself follows https://www.sqlite.org/lang_altertable.html):
--     1. (skipped) `PRAGMA foreign_keys = OFF` — sqlx wraps every
--        migration in a transaction; PRAGMA `foreign_keys` cannot
--        change inside a tx so issuing it here would be a no-op.  This
--        means the INSERT below enforces FKs as it runs, which is fine
--        — every value_ref in `block_properties` already points at a
--        live block row post-0061's cleanup.
--     2. (audit) — see Backfill audit above; performed implicitly by
--        the CHECK during the INSERT copy step.
--     3. Create `_new_block_properties` with the new compound CHECK,
--        keeping the FK clauses from 0061 verbatim and the narrow
--        `value_bool IN (0, 1)` check alongside the new one.
--     4. Copy rows over (CHECK validates each row).
--     5. Drop the old table (also drops every index on it).
--     6. Rename the new table into place.
--     7. Recreate every live index from 0061.
--
-- This migration only changes the schema, never touches application
-- code paths that write properties.  All such paths already produce
-- rows that satisfy the new CHECK (validated in Rust today), so post-
-- migration behaviour is identical to pre-migration behaviour except
-- that an invariant violation now fails fast at the storage layer.

-- ---------------------------------------------------------------------
-- Step 3: create the new table.  FK clauses and the narrow
-- `value_bool IN (0, 1)` check are preserved verbatim from migration
-- 0061; the new compound CHECK is added alongside them as a
-- table-level constraint.
-- ---------------------------------------------------------------------
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
    )
) STRICT;

-- ---------------------------------------------------------------------
-- Step 4: copy data.  If any existing row violates the new CHECK the
-- INSERT fails here, rolling back the transaction and leaving the
-- original `block_properties` table untouched.
-- ---------------------------------------------------------------------
INSERT INTO _new_block_properties
    (block_id, key, value_text, value_num, value_date, value_ref, value_bool)
    SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool
    FROM block_properties;

-- ---------------------------------------------------------------------
-- Step 5 + 6: drop old, rename new into place.
-- ---------------------------------------------------------------------
DROP TABLE block_properties;
ALTER TABLE _new_block_properties RENAME TO block_properties;

-- ---------------------------------------------------------------------
-- Step 7: recreate every live index from migration 0061 verbatim.
-- Index names and definitions must match exactly so downstream
-- `EXPLAIN QUERY PLAN` assertions and the audit in 0045 remain valid.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_block_props_key
    ON block_properties(key, block_id);
CREATE INDEX IF NOT EXISTS idx_block_props_key_text
    ON block_properties(key, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_props_date
    ON block_properties(value_date) WHERE value_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_key_value_num
    ON block_properties(key, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_value_bool
    ON block_properties(value_bool) WHERE value_bool IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_space_covering
    ON block_properties(value_ref, block_id) WHERE key = 'space';
