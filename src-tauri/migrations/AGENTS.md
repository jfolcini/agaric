# `src-tauri/migrations/` — SQLite schema migrations

> Rules for writing SQL migrations against Agaric's SQLite store. Root [`AGENTS.md`](../../AGENTS.md) covers cross-cutting invariants; this file covers what's specific to the migrations directory.

## Append-only — never modify a shipped migration

Once a migration ships in a release, it is **immutable**. Edits to existing `.sql` files corrupt user databases (the migrator records each applied migration's hash; mismatched hashes refuse to run). New schema changes always land as a new migration file with the next number.

- **New migration:** `NNNN_short_description.sql` in this directory. `NNNN` is the next integer, zero-padded to 4 digits.
- **Fixing a mistake in an unreleased migration:** OK to edit until the release tag. After tag, immutable.
- **Pre-commit guard:** the `migrations-immutable` prek hook compares HEAD vs. branch and fails the commit if any file in this directory is modified. Honour it.

## `STRICT` tables required for every new table

Every `CREATE TABLE` in a new migration MUST carry the `STRICT` keyword:

```sql
CREATE TABLE blocks (
  id TEXT NOT NULL PRIMARY KEY,
  block_type TEXT NOT NULL,
  -- …
) STRICT;
```

SQLite's silent type coercion (e.g. inserting `"42"` into an `INTEGER` column accepted as `42`) is a known correctness footgun. `STRICT` mode (3.37+) catches it at insert time. Existing tables shipped without `STRICT` are not retrofitted — adding `STRICT` to a CREATE retroactively would change semantics. The `migrations-strict-required` prek hook enforces this on new CREATEs.

**FTS5 carve-out**: `CREATE VIRTUAL TABLE … USING fts5(…)` does NOT accept `STRICT`. FTS5 tables are excluded from the hook automatically; do not try to add `STRICT` to them.

## Indexes go in the same migration that creates the table

A new table that depends on an index for query performance should ship both in one migration. Splitting them across migrations means the brief gap (the period after the table ships and before the index migration runs) is an unindexed window. SQLite is fast enough at small tables that this rarely matters, but the convention removes the question.

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

- All connections enable `PRAGMA foreign_keys = ON` (set in the pool init).
- `FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE` is the common shape; specify `ON DELETE` explicitly.
- Cascade rules are part of the data model — a future plan changing them is a breaking change.

## Timestamp columns: INTEGER ms since the Unix epoch

Issue #109 — every **new** timestamp column must use INTEGER milliseconds-since-the-Unix-epoch, never TEXT ISO-8601. The canonical shape is:

```sql
CREATE TABLE example (
  id      TEXT NOT NULL PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
```

- **Column suffix:** `_ms` — makes the encoding visible at every read site without consulting the schema.
- **CHECK predicate:** `>= 0` — rejects pre-epoch nonsense at insert time, matching the same defence-in-depth posture as the per-column `CHECK` constraints elsewhere in the schema (0062 `exactly_one_value`, 0073 `page_id_self_for_pages`).
- **Writer helper:** `crate::db::now_ms()` (`src-tauri/src/db.rs`) is the single source of truth for the current value. No call site should open-code `chrono::Utc::now().timestamp_millis()`.

Rationale: range scans on staleness windows are direct integer comparisons (`WHERE updated_at_ms <= ?`), with no `strftime` parsing and no `Z` vs `+00:00` lex-collation hazard. SQLite INTEGER columns sort and range-scan natively without relying on every writer producing the same `YYYY-MM-DDTHH:MM:SS.sssZ` shape that the legacy TEXT encoding required.

Precedent: `loro_doc_state.updated_at` (migration 0052) and `app_settings.updated_at` (migration 0053) already follow this shape. The legacy TEXT columns (`blocks.deleted_at`, `op_log.created_at`, `materializer_retry_queue.created_at`, etc.) keep `crate::now_rfc3339` until Phase 2 of #109 migrates each one in turn.

### Calendar dates are TEXT `YYYY-MM-DD` — and stay that way (#588)

The INTEGER-ms rule above is for **instants** (a precise moment in time). It does **not** apply to **calendar dates** — `blocks.due_date`, `blocks.scheduled_date`, and `block_properties.value_date`. These are intentionally `TEXT` in `'YYYY-MM-DD'` form and must NOT be migrated to epoch-ms:

- A due/scheduled date is "June 15", not an instant. Encoding it as epoch-ms would invent a spurious time-of-day and timezone.
- `'YYYY-MM-DD'` is lexicographically sortable, so the agenda's range queries (`WHERE due_date BETWEEN ? AND ?`) work directly, and SQLite's `date()` / `strftime()` operate on it natively.
- SQLite has no native `DATE` type anyway (storage classes are NULL/INTEGER/REAL/TEXT/BLOB; under `STRICT` only INT/INTEGER/REAL/TEXT/BLOB/ANY are accepted), so `TEXT` is the idiomatic encoding for a date-without-time.

A future "finish the #109 timestamp → INTEGER migration" sweep must skip these three columns.

## Op log: never write to it from a migration

The op log (`op_log`) is the event-sourcing root. Migrations that change schema MUST NOT backfill op log rows for the new schema — that would inject synthetic ops into the user's history. Backfill should happen lazily through normal command paths, OR through a one-time materializer task triggered after the schema is in place.

## Table-rebuild migrations (`_new_<table>` prefix convention)

When a table rebuild is needed (e.g. to add a `FOREIGN KEY … ON DELETE CASCADE` that SQLite cannot add via `ALTER TABLE`), create the replacement as `_new_<table>`, backfill, then rename. Two legacy migrations (0038 `block_drafts_new` and 0044 `materializer_retry_queue_new`) used a suffix form (`<table>_new`) and are exceptions to this rule. From migration 0061 onward the canonical prefix form `_new_<table>` is used; future rebuilds must follow the prefix convention.

### `DROP TABLE` fires `ON DELETE CASCADE` immediately — preserve authoritative children (#606)

Under `foreign_keys = ON` (every connection, including the migration transaction), the rebuild's `DROP TABLE <parent>` step **immediately cascade-deletes every row** of every child table holding an `ON DELETE CASCADE` FK into it. The cascade is part of the DROP itself, **not** a deferred FK validation, so the per-migration transaction does not protect children — only the *parent's* rows survive (via the `_new_` bulk copy). This is verified mechanically by the `*_376` and `*_606` harness tests in `src-tauri/src/db.rs` (seed-then-migrate).

Two more empirically-pinned DROP facts (SQLite 3.50; see `agents_md_table_rebuild_recipe_preserves_satellites_606`):

- There is **no commit-time FK row re-validation**. If a **non**-CASCADE child still holds referencing rows, the DROP aborts at the statement with `FOREIGN KEY constraint failed` — transaction or not. Rebuilds only ever "work" because every populated child either carries CASCADE (and is silently wiped) or is empty.
- The `_new_<table>` DDL must redirect **self**-FKs to `_new_<table>` (0085 precedent: `parent_id TEXT REFERENCES _new_blocks(id)`). A self-FK left pointing at the old table makes the DROP abort the same way, because the freshly copied `_new_` rows still reference it. The post-swap `ALTER TABLE … RENAME` rewrites those references back to the real name.

Most cascade children of `blocks` (attachments, properties, tags) re-materialize from the op log at next boot, so the shipped rebuilds only cost a recovery pass for them. Two do **not**:

- `page_aliases` — emits no op_log entries (#110); only the user command writes it.
- `block_drafts` — device-local, never synced or snapshotted.

These are **authoritative**: the shipped blocks rebuilds (0073, 0080, 0085) permanently destroyed both for upgrading users.

**Correction of record:** migration 0085's header claims the rebuild "is safe because the bulk copy is a pure `INSERT ... SELECT` (no rows deleted from `blocks`), so referencing FK rows keep pointing at valid ids throughout." That claim is **false** for cascade children — the DROP wipes them regardless of the copy. Migrations are append-only, so the comment cannot be fixed in place; this section is the correction. Do not copy that rationale into a future rebuild.

**Rule for every future rebuild of a table with inbound `ON DELETE CASCADE` FKs:** copy each authoritative child table aside before the DROP and restore it after the rename. `PRAGMA foreign_keys = OFF` is *not* an option — sqlx wraps each migration in a transaction and the pragma is a no-op inside one. The recipe (`CREATE TEMP TABLE … AS SELECT` carries no type info, so STRICT does not apply; the scratch table is dropped in the same migration):

```sql
-- 1. Copy authoritative children aside (BEFORE the DROP).
CREATE TEMP TABLE _keep_page_aliases AS SELECT * FROM page_aliases;
CREATE TEMP TABLE _keep_block_drafts AS SELECT * FROM block_drafts;

-- 2. The rebuild swap. The DROP cascade-empties the children HERE.
DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- 3. Restore the children (their tables survive the cascade, emptied).
INSERT INTO page_aliases SELECT * FROM _keep_page_aliases;
INSERT INTO block_drafts SELECT * FROM _keep_block_drafts;
DROP TABLE _keep_page_aliases;
DROP TABLE _keep_block_drafts;
```

For `blocks`, the authoritative children were exactly `page_aliases` and `block_drafts` through migration 0088; **as of 0089 the preserve set also includes `spaces`** — wiping `spaces` is doubly destructive because `blocks.space_id … ON DELETE SET NULL` then silently clears every space membership. 0089 sidesteps this by keeping `spaces` EMPTY until after the rename (snapshot to `_spaces_backfill` first, populate last); copy that choreography in any future rebuild, and re-check the full list against the FK graph when writing one. Two enforcement layers exist: the `migrations-rebuild-cascade` prek hook (`scripts/check-migrations-rebuild-cascade.mjs`) greps any new migration containing `DROP TABLE blocks` for the satellite table names, and `future_blocks_rebuild_migrations_must_preserve_alias_and_draft_rows_606` (`src-tauri/src/db.rs`) seeds the satellites immediately before every post-0085 rebuild and asserts the rows reach head.

`PRAGMA defer_foreign_keys = ON` (first statement of the migration) defers FK *violation checks* to COMMIT — useful for circular FKs like `spaces(id) ↔ blocks.space_id` (0089) — but does **not** defer cascade/SET NULL actions.

### Trigger bodies: never rely on `INSERT OR IGNORE` for idempotency

SQLite replaces the conflict policy of statements **inside a trigger body** with the policy of the **outer statement** that fired the trigger ([lang_createtrigger](https://sqlite.org/lang_createtrigger.html)). An outer `INSERT OR REPLACE` (the `set_property` UPSERT shape) turns a body-level `OR IGNORE` into `OR REPLACE` — and a REPLACE on a PK deletes + re-inserts the row, firing any `ON DELETE` actions hanging off it. Put the idempotency guard in the trigger's `WHEN` clause (`NOT EXISTS (…)`) so the body statement can never hit a conflict (in-repo model: 0089 `spaces_register_is_space`).

## Renaming + dropping tables

Renaming or dropping a column / table is destructive. Always:

1. Add the new column / table.
2. Backfill via a separate command-handler dual-write phase (or a one-time task).
3. Drop the old column / table only after a release in which both coexist.

Migration-time `ALTER TABLE … DROP COLUMN` is supported in SQLite 3.35+ but is a one-way trip; don't combine it with the migration that adds the replacement.

## Verifying a migration

```bash
cd src-tauri && cargo sqlx prepare -- --tests
```

Re-generates the offline `.sqlx/` cache. Run after any migration that adds a new query macro site. CI will fail if you forget.

```bash
cd src-tauri && cargo nextest run migration_tests
```

Runs the per-migration round-trip tests. A new migration needs a corresponding test fixture that inserts representative data + reads it back; lock the schema's external contract early.

## Cross-references

- Root [`AGENTS.md`](../../AGENTS.md) §Key Architectural Invariants — invariant #1 (op log is append-only).
- [`docs/architecture/ci-and-tooling.md`](../../docs/architecture/ci-and-tooling.md) §Migrations — high-level pipeline.
- [`src-tauri/tests/AGENTS.md`](../tests/AGENTS.md) — test patterns for migration-touching code.
