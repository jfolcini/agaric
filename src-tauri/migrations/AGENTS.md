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

## Op log: never write to it from a migration

The op log (`op_log`) is the event-sourcing root. Migrations that change schema MUST NOT backfill op log rows for the new schema — that would inject synthetic ops into the user's history. Backfill should happen lazily through normal command paths, OR through a one-time materializer task triggered after the schema is in place.

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
