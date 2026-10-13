# `src-tauri/migrations/` — SQLite schema migrations

## Append-only

The migrator records each applied file's hash and refuses to start on a mismatch, so editing a shipped `.sql` breaks every existing database. Schema changes land as a new `NNNN_short_description.sql` (next integer, 4 digits). An unreleased migration may be edited until the release tag; the `migrations-immutable` hook blocks edits to any existing file.

## New tables

- `STRICT`, because SQLite otherwise coerces types silently. Existing tables are not retrofitted; FTS5 virtual tables cannot be `STRICT` and the `migrations-strict-tables` hook skips them.
- Indexes ship in the same migration as their table, so there is no unindexed window.
- Every FK names its `ON DELETE` explicitly (`REFERENCES blocks(id) ON DELETE CASCADE` is the usual shape). Cascade rules are part of the data model; changing one is a breaking change.

## Timestamps

New timestamp columns are `<col>_ms INTEGER NOT NULL CHECK (<col>_ms >= 0)` (#109): integer range scans need no `strftime` and have no `Z` vs `+00:00` collation hazard. Write them with `crate::db::now_ms()`, never an open-coded `chrono::Utc::now().timestamp_millis()`; `crate::now_rfc3339()` is for logs and display only.

- A column paired with an existing unsuffixed one stays unsuffixed (`peer_refs.streamed_at` beside `synced_at`, 0111), since suffixing one half implies the encodings differ.
- Calendar dates stay TEXT `YYYY-MM-DD` (#588): `blocks.due_date`, `blocks.scheduled_date`, `block_properties.value_date`. Epoch-ms would invent a time and timezone, and the text form sorts for the agenda's `BETWEEN` queries.

## Never write `op_log` from a migration

Backfilled rows would inject synthetic ops into the user's history. Backfill through normal command paths or a one-time materializer task after the schema lands.

## Table ownership

Each core table has one owner crate, and new raw `sqlx` writes to it go there; other crates call an owner function, so the table's invariants (cache coherence, op-log ordering, soft-delete) stay in one place.

| Table | Owner | Notes |
|---|---|---|
| `peer_refs` | `store` | |
| `pages_cache`, `tags_cache`, `agenda_cache`, `block_links`, `page_link_cache`, `projected_agenda_cache`, `block_tag_refs`, `block_tag_inherited` | `store` | `engine` is a sanctioned projection-time co-writer. |
| `blocks` | `engine` | Loro→SQLite projection. `store` keeps the physical primitives beneath it (page_id/space_id materialization, soft-delete, descendant cache). app/sync writes are known debt. |
| `op_log` | `store` | Append primitive in `src-tauri/agaric-store/src/op_log/append.rs`. app/engine/sync writes are known debt. |

The `check-table-ownership` hook fails when a non-owner (crate, table) raw-write count exceeds `src-tauri/table-ownership-baseline.txt`. After adding a required cross-crate write, or removing one, run `python3 scripts/check-table-ownership.py --update-baseline` (it keeps the file's annotations).

## Table rebuilds

When `ALTER TABLE` cannot express a change, create `_new_<table>` (prefix, not the legacy `<table>_new`), copy, `DROP` the old table, `RENAME`.

### `DROP TABLE` cascades immediately (#606)

With `foreign_keys = ON`, `DROP TABLE <parent>` deletes every row of every `ON DELETE CASCADE` child at once. The migration transaction does not protect them, and `PRAGMA foreign_keys = OFF` is a no-op inside a transaction. Also:

- A non-CASCADE child with referencing rows makes the DROP abort with `FOREIGN KEY constraint failed`.
- The `_new_<table>` DDL must point self-FKs at `_new_<table>` (0085: `parent_id TEXT REFERENCES _new_blocks(id)`) or the DROP aborts the same way; the `RENAME` rewrites them back.

Most cascade children of `blocks` re-materialize from the op log at boot. These do not, so a rebuild destroys them:

- `page_aliases`: no op_log entries.
- `block_drafts`: device-local, never synced.
- `spaces` and every non-NULL `blocks.space_id` (since 0089): the DROP cascades into `spaces`, and deleting a space `SET NULL`s its members.

0085's header calls its pure `INSERT … SELECT` rebuild safe; it is not, so do not copy it. A rebuild of a table with inbound CASCADE FKs snapshots each authoritative child before the DROP and restores it after the RENAME. For `blocks`, copy this recipe in full (`CREATE TEMP TABLE … AS SELECT` carries no types, so STRICT does not apply):

```sql
-- Must be the migration's first statement. This defers FK violation
-- checks only; CASCADE and SET NULL actions still fire immediately.
PRAGMA defer_foreign_keys = ON;

-- 1. Snapshot every authoritative child and member assignment into
-- no-FK scratch tables (BEFORE touching the live registry or blocks).
CREATE TEMP TABLE _keep_page_aliases AS SELECT * FROM page_aliases;
CREATE TEMP TABLE _keep_block_drafts AS SELECT * FROM block_drafts;
CREATE TEMP TABLE _keep_spaces AS SELECT * FROM spaces;
CREATE TEMP TABLE _keep_block_spaces AS
    SELECT id AS block_id, space_id
      FROM blocks
     WHERE space_id IS NOT NULL;

-- 2. Empty the registry before copying/rebuilding blocks. This SET NULLs
-- live blocks.space_id immediately; _keep_block_spaces preserves them.
DELETE FROM spaces;

-- 3. Create _new_blocks here by copying the complete current blocks schema.
-- Redirect parent_id/page_id self-FKs to _new_blocks(id); keep space_id
-- REFERENCES spaces(id) ON DELETE SET NULL. Then copy the now-space-less
-- rows. spaces MUST remain empty/absent through DROP and RENAME or the
-- blocks → spaces CASCADE will wipe it and fan out SET NULL into replacement.
INSERT INTO _new_blocks SELECT * FROM blocks;
DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- 4. Restore registry owners after the rename, then repair memberships.
-- The owner row must exist before each blocks.space_id FK is restored.
INSERT INTO spaces SELECT * FROM _keep_spaces;
UPDATE blocks
   SET space_id = (
       SELECT space_id
         FROM _keep_block_spaces
        WHERE block_id = blocks.id
   )
 WHERE id IN (SELECT block_id FROM _keep_block_spaces);

-- 5. Restore the other authoritative children and remove all scratch.
INSERT INTO page_aliases SELECT * FROM _keep_page_aliases;
INSERT INTO block_drafts SELECT * FROM _keep_block_drafts;
DROP TABLE _keep_page_aliases;
DROP TABLE _keep_block_drafts;
DROP TABLE _keep_spaces;
DROP TABLE _keep_block_spaces;
```

`PRAGMA defer_foreign_keys = ON` defers violation checks to COMMIT (needed for the circular `spaces(id) ↔ blocks.space_id`) but never defers CASCADE or SET NULL actions.

Guards:

- `migrations-rebuild-cascade` checks the snapshot/restore statements and their order in any migration with `DROP TABLE blocks`, against the column set replayed from migration history. Use `SELECT *` on both sides: a narrowed column list or `NULL AS <column>` loses data and is rejected (#3438).
- `migrations-rebuild-cascade-self-test` runs the block above through that guard and compares it statement by statement with the `recipe` executed by `agents_md_table_rebuild_recipe_preserves_authoritative_state_606` in `src-tauri/src/db/tests.rs`. Edit both copies together.
- `future_blocks_rebuild_migrations_must_preserve_authoritative_state_606` seeds an owner and membership before every post-0089 rebuild and asserts at head.

### Trigger bodies: idempotency goes in `WHEN`, not `INSERT OR IGNORE`

SQLite replaces a trigger body's conflict policy with the outer statement's ([lang_createtrigger](https://sqlite.org/lang_createtrigger.html)), so an outer `INSERT OR REPLACE` turns a body-level `OR IGNORE` into a delete-and-reinsert that fires `ON DELETE` actions. Guard with `WHEN NOT EXISTS (…)` instead (model: 0089 `spaces_register_is_space`).

## Boot recovery runs before migrations

`ensure_blocks_table_exists` (`src-tauri/src/db/recovery.rs`) runs before `sqlx::migrate!`, against whatever schema era the vault is at. The `query!` macros check against the head schema, so code on that path probes with `pragma_table_info` and uses dynamic `sqlx::query`. Old eras store RFC 3339 TEXT timestamps: `op_log.created_at` before 0079, `blocks.deleted_at` before 0080.

## Renaming or dropping columns and tables

Add the new column or table, backfill (dual-write in the command handler, or a one-time task), and drop the old one only after a release in which both coexist. `ALTER TABLE … DROP COLUMN` is one-way; never put it in the migration that adds the replacement.

## Verifying a migration

Every new migration needs a test that inserts representative data and reads it back, named `<table>_<NNNN>_<what>_<issue>` (e.g. `peer_refs_0111_streamed_at_add_preserves_existing_rows_4084`), in `src-tauri/src/db/tests.rs`, `src-tauri/src/spaces/tests.rs` or `src-tauri/agaric-sync/src/snapshot/tests.rs`. The `migration-test-coverage` hook enforces this but is manual-stage, so run `node scripts/check-migration-test-coverage.mjs` before pushing; older migrations are grandfathered in `src-tauri/migrations-test-coverage-baseline.txt`. Run them all with:

```bash
cd src-tauri && cargo nextest run --workspace -E 'test(/_(376|606|708)$|_0[0-9]{3}_/)'
```

The `_376`/`_606`/`_708` suffixes pin tests that predate the naming convention. The leading `0` in `_0[0-9]{3}_` keeps it off issue numbers and sizes, so revisit the filter at migration `1000`.

## Mock contract

Root [`AGENTS.md` § Testing invariants](../../AGENTS.md#testing-invariants-anti-drift) requires updating the mock with the migration. The `check-migration-mock-contract` hook fails a new migration touching a table the mock models unless a modeling mock file changed too or the migration carries a `-- mock-unaffected: <reason>` line (index-only or derived-cache-only changes). After landing a migration, grandfather it with `python3 scripts/check-migration-mock-contract.py --update-baseline`.
