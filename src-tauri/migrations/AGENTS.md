# `src-tauri/migrations/` — SQLite schema migrations

> Rules specific to this directory. Cross-cutting invariants live in the root [`AGENTS.md`](../../AGENTS.md).

## Append-only — never modify a shipped migration

The migrator records each applied file's hash and refuses to run on a mismatch, so editing a released `.sql` breaks every existing database. Schema changes land as a new file.

- New migration: `NNNN_short_description.sql`, where `NNNN` is the next integer, zero-padded to 4 digits.
- An unreleased migration may be edited until the release tag.
- Guard: the `migrations-immutable` prek hook fails the commit if any existing file here changes.

## `STRICT` on every new table

SQLite silently coerces types (`"42"` into an INTEGER column becomes `42`); `STRICT` (3.37+) rejects it at insert time.

```sql
CREATE TABLE blocks (
  id TEXT NOT NULL PRIMARY KEY,
  block_type TEXT NOT NULL,
  -- …
) STRICT;
```

Existing non-STRICT tables are not retrofitted. `CREATE VIRTUAL TABLE … USING fts5(…)` does not accept `STRICT`; the `migrations-strict-tables` hook excludes FTS5 tables automatically.

## Indexes ship in the same migration as the table

Splitting them across migrations leaves an unindexed window between the two.

```sql
CREATE TABLE block_links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  -- …
) STRICT;

CREATE INDEX idx_block_links_target ON block_links (target_id);
CREATE INDEX idx_block_links_source ON block_links (source_id);
```

## Foreign keys

- Every connection runs with `PRAGMA foreign_keys = ON` (set in the pool init).
- Specify `ON DELETE` explicitly; `REFERENCES blocks(id) ON DELETE CASCADE` is the common shape.
- Cascade rules are part of the data model; changing one is a breaking change.

## Timestamps: INTEGER ms since the Unix epoch (#109)

Every new timestamp column is INTEGER epoch-milliseconds, never TEXT ISO-8601: integer range scans need no `strftime` parsing and carry no `Z` vs `+00:00` collation hazard.

```sql
CREATE TABLE example (
  id      TEXT NOT NULL PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
```

- Suffix `_ms`, so the encoding is visible at every read site.
- `CHECK (… >= 0)` rejects pre-epoch values at insert time.
- Write with `crate::db::now_ms()` (`src-tauri/agaric-store/src/db/mod.rs`); never open-code `chrono::Utc::now().timestamp_millis()`. `crate::now_rfc3339()` is for logs and display only.
- Exception: a column that is half of an existing unsuffixed pair stays unsuffixed (`peer_refs.streamed_at` pairs with `synced_at`, 0111), because suffixing one half implies the two encodings differ. No hook enforces the suffix.

The root [`AGENTS.md`](../../AGENTS.md) §Database states the rule; the legacy TEXT columns are already migrated (migrations 0074–0082).

### Calendar dates stay TEXT `YYYY-MM-DD` (#588)

`blocks.due_date`, `blocks.scheduled_date` and `block_properties.value_date` are dates, not instants: epoch-ms would invent a time-of-day and timezone, and `YYYY-MM-DD` sorts lexicographically for the agenda's `BETWEEN` queries. Never migrate them.

## Never write `op_log` from a migration

`op_log` is the event-sourcing root; a migration that backfills rows injects synthetic ops into the user's history. Backfill lazily through normal command paths or a one-time materializer task after the schema lands.

## Table ownership (which crate may raw-write which table)

The store is written from four crates: app (`src-tauri/src`), `agaric-store`, `agaric-engine` and `agaric-sync`. Each core table has one owner crate. A new raw `sqlx` write site goes in the table's owner; any other crate calls a store/owner function instead of open-coding an `INSERT`/`UPDATE`/`DELETE`, so the table's invariants (cache coherence, op-log ordering, soft-delete) stay in one place.

| Table | Owner | Notes |
|---|---|---|
| `peer_refs` | `store` | Clean single-writer case. |
| `pages_cache`, `tags_cache`, `agenda_cache`, `block_links`, `page_link_cache`, `projected_agenda_cache`, `block_tag_refs`, `block_tag_inherited` | `store` | Derived caches. `engine` is a sanctioned projection-time co-writer. |
| `blocks` | `engine` | Loro→SQLite projection writer. `store` keeps the physical block primitives beneath it (page_id/space_id materialization, soft-delete, descendant cache) as owner-adjacent carve-outs. app/sync writes are known debt. |
| `op_log` | `store` | Append primitive: `src-tauri/agaric-store/src/op_log/append.rs`. app/engine/sync writes are known debt. |

Existing cross-crate writes are grandfathered in `src-tauri/table-ownership-baseline.txt`, each line `<count> <crate> <table> [# note]` annotated as a carve-out or `# migrating: slice N`. The `check-table-ownership` hook (`scripts/check-table-ownership.py`) counts raw writes per (crate, table) across the four crates plus `diagnostics` (its `src/bin` tools and test-only modules excluded) and fails when a non-owner pair exceeds its baseline, so it blocks only new cross-crate writes. After adding a genuinely required cross-crate write, or removing one to lower the floor:

```bash
python3 scripts/check-table-ownership.py --update-baseline
```

It recomputes counts and preserves the header, comment blocks and inline annotations.

## Table rebuilds (`_new_<table>` prefix)

When `ALTER TABLE` cannot express a change (e.g. adding an `ON DELETE CASCADE` FK), create `_new_<table>`, copy, `DROP` the old table, `RENAME`. Two legacy migrations (0038, 0044) used the `<table>_new` suffix; use the prefix form.

### `DROP TABLE` cascades immediately — preserve authoritative children (#606)

With `foreign_keys = ON`, `DROP TABLE <parent>` immediately deletes every row of every child holding an `ON DELETE CASCADE` FK into it. The migration transaction does not protect them, and `PRAGMA foreign_keys = OFF` is a no-op inside a transaction. Two more facts pinned by `agents_md_table_rebuild_recipe_preserves_authoritative_state_606`:

- A non-CASCADE child still holding referencing rows makes the DROP abort with `FOREIGN KEY constraint failed`; there is no commit-time re-validation.
- The `_new_<table>` DDL must redirect self-FKs to `_new_<table>` (0085: `parent_id TEXT REFERENCES _new_blocks(id)`) or the DROP aborts the same way; the `RENAME` rewrites them back.

Most cascade children of `blocks` re-materialize from the op log at next boot. These do not, and the shipped rebuilds (0073, 0080, 0085) destroyed them for upgrading users:

- `page_aliases` — emits no op_log entries; only the user command writes it.
- `block_drafts` — device-local, never synced or snapshotted.
- Since 0089: the `spaces` registry and every non-NULL `blocks.space_id`. The DROP cascades into `spaces`, and deleting a space `SET NULL`s its members' `space_id` in the replacement table.

Migration 0085's header claims the rebuild is safe because the copy is a pure `INSERT … SELECT`. That is wrong for cascade children; do not copy it into a future rebuild.

Every future rebuild of a table with inbound CASCADE FKs snapshots each authoritative child into a scratch table before the DROP and restores it after the RENAME. For `blocks`, copy this recipe in full (`CREATE TEMP TABLE … AS SELECT` carries no type info, so STRICT does not apply):

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

`PRAGMA defer_foreign_keys = ON` defers FK violation checks to COMMIT (needed for the circular `spaces(id) ↔ blocks.space_id`) but never defers CASCADE/SET NULL actions.

Guards:

- `migrations-rebuild-cascade` validates the snapshot/restore statements and their order for every migration containing `DROP TABLE blocks`. The required column set is replayed from migration history and enforced on both arms: a narrowed restore (`INSERT INTO block_drafts (block_id, content, updated_at) SELECT …`) loses columns as surely as a narrowed snapshot, and `NULL AS <column>` is rejected as the default-write it is (#3438). Use `SELECT *` on both sides.
- `migrations-rebuild-cascade-self-test` runs the `sql` block above through the guard as the next rebuild against the head schema and compares it statement-for-statement with the `recipe` executed by `agents_md_table_rebuild_recipe_preserves_authoritative_state_606` in `src-tauri/src/db/tests.rs` (modulo the `_new_blocks` DDL). Editing either copy re-runs the hook.
- `future_blocks_rebuild_migrations_must_preserve_authoritative_state_606` seeds an owner plus membership before every post-0089 rebuild and asserts at head; `spaces_0089_backfill_preserves_satellites_and_repairs_orphans_708` covers 0089 itself.

### Trigger bodies: idempotency goes in `WHEN`, not `INSERT OR IGNORE`

SQLite replaces a trigger body's conflict policy with the outer statement's ([lang_createtrigger](https://sqlite.org/lang_createtrigger.html)). An outer `INSERT OR REPLACE` turns a body-level `OR IGNORE` into `OR REPLACE`, which deletes and re-inserts the row and fires its `ON DELETE` actions. Guard with `WHEN NOT EXISTS (…)` so the body never hits a conflict (model: 0089 `spaces_register_is_space`).

## Renaming or dropping columns and tables

1. Add the new column/table.
2. Backfill via a dual-write phase in the command handler, or a one-time task.
3. Drop the old one only after a release in which both coexist.

`ALTER TABLE … DROP COLUMN` (SQLite 3.35+) is one-way; never put it in the migration that adds the replacement.

## Verifying a migration

```bash
just gen-sqlx
```

Regenerates all four offline `.sqlx/` caches; run it after any migration that adds a query-macro site. A bare `cargo sqlx prepare` silently drops leaf-crate queries. CI fails if you forget.

```bash
cd src-tauri && cargo nextest run -E 'test(/_(376|606|708)$|_0[0-9]{3}_/)'
```

Runs the per-migration round-trip / data-preservation tests. These live in `db::tests` (`src-tauri/src/db/tests.rs`) and its `snapshot`/`spaces` sibling `tests.rs` files, under two naming conventions:

- **Older batch, pinned by issue number.** The `_376`/`_606`/`_708` tests (round-trip + cascade harness, satellite preservation, spaces registry) predate the migration-number convention, so those three suffixes stay pinned in the filter.
- **Current convention, matched by pattern.** `<table>_<NNNN>_<what>_<issue>`, e.g. `peer_refs_0111_streamed_at_add_preserves_existing_rows_4084`. The `_0[0-9]{3}_` half of the filter selects any name embedding a zero-padded migration number, so no filter edit is needed per migration.
- **Ceiling: migration numbers below `1000`.** The leading literal `0` is what keeps `_0[0-9]{3}_` from matching issue numbers, years and sizes in other test names. Revisit the filter when numbers reach `1000`.
- **Contributor rule.** Every new migration needs a test that inserts representative data and reads it back, named with its `_<NNNN>_` number. The `migration-test-coverage` hook (`scripts/check-migration-test-coverage.mjs`) fails on a migration with no such test in the three files above; pre-convention migrations are grandfathered in `src-tauri/migrations-test-coverage-baseline.txt`.

There is no `migration_tests` module; the regex filter is what selects these tests.

## Migration → mock: update the JS mock in the same PR (#3084)

The browser/e2e Tauri mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation of the schema, so a migration that changes a table or column the mock models leaves it silently modeling the old schema (the tag-space bug: the mock kept reading a retired `block_properties(key='space')` row after the tag moved to a native column). Rule: such a migration updates the mock in the same PR and adds or adjusts a `conformance/fixtures/*.json` fixture. The [`conformance-coverage.test.ts`](../../src/lib/tauri-mock/__tests__/conformance-coverage.test.ts) ratchet keeps mutating commands fixture-covered; see root [`AGENTS.md` § Testing invariants](../../AGENTS.md#testing-invariants-anti-drift).

Guard: `check-migration-mock-contract` (`scripts/check-migration-mock-contract.py`) maps each backend table to the mock files that model it and fails on any new migration touching a mapped table unless a modeling mock file changed alongside it or the migration carries a literal `-- mock-unaffected: <reason>` line (for index-only / derived-cache-only changes). In CI's `--all-files` run every mock file is "changed", so there only the annotation or baseline membership exempts. After landing a migration, grandfather it:

```bash
python3 scripts/check-migration-mock-contract.py --update-baseline
```

## Cross-references

- Root [`AGENTS.md`](../../AGENTS.md) §Key Architectural Invariants — invariant #1 (op log is append-only).
- [`docs/architecture/ci-and-tooling.md`](../../docs/architecture/ci-and-tooling.md) §Migrations — high-level pipeline.
- [`src-tauri/tests/AGENTS.md`](../tests/AGENTS.md) — test patterns for migration-touching code.
