# PEND-07 — `STRICT` tables policy for new migrations

## Problem

SQLite's `STRICT` table mode (added in 3.37, available everywhere we ship) prevents silent type coercion bugs by enforcing that values match declared column types. Without `STRICT`, SQLite happily stores a string in an `INTEGER` column or a number in `TEXT`, surfacing as runtime correctness bugs only when the data is later read or compared.

Currently **zero of the 41 migrations in `src-tauri/migrations/`** use `STRICT`. Retrofitting existing tables is a poor cost/benefit trade (large migration, many downstream tests). But every **new** table added from now on should be `STRICT` by default.

## Goal

Establish "new tables are `STRICT`" as a written invariant and enforce it with a pre-commit hook.

## Approach

### Step 1 — Add the policy to AGENTS.md

Add one bullet under the existing "Database" section in AGENTS.md:

```markdown
- **`STRICT` tables for new schema.** Every new `CREATE TABLE` in a migration must use `STRICT`. Existing tables are not retrofitted. Rationale: SQLite's silent type coercion is a known correctness footgun; `STRICT` mode (3.37+) catches it at insert time.
```

### Step 2 — Pre-commit hook

Add a hook to `prek.toml` that fails on any new `CREATE TABLE` in a migration that omits `STRICT` (and isn't a virtual table — FTS5 doesn't accept `STRICT`).

**Algorithm:**

1. Find any added or modified `*.sql` files under `src-tauri/migrations/`.
2. For each, parse line-by-line for `CREATE TABLE` statements (case-insensitive).
3. Skip statements that include `VIRTUAL TABLE` (FTS5, etc.).
4. For each remaining `CREATE TABLE`, find its terminating `)`. Check whether the post-`)` portion of the statement (until `;`) contains the `STRICT` keyword.
5. If not, fail with:

   ```text
   ERROR: migrations/<file>.sql line <N>: CREATE TABLE <name> must use STRICT mode (see AGENTS.md § Database)
   ```

**Hook config to add to `prek.toml`:**

```toml
[[repos.hooks]]
id = "migrations-strict-tables"
name = "migrations: STRICT tables required for new schema"
entry = "node scripts/check-migrations-strict.mjs"
language = "system"
pass_filenames = false
files = "^src-tauri/migrations/.*\\.sql$"
```

**Script location:** `scripts/check-migrations-strict.mjs` (mirroring the pattern of `check-migrations-immutable.sh`).

### Step 3 — Document the FTS5 carve-out

The existing `migrations/0002_fts5.sql` and `0006_fts5_trigram.sql` use `CREATE VIRTUAL TABLE`, which doesn't accept `STRICT`. The hook script must skip virtual tables, and AGENTS.md should mention this carve-out.

## Files touched

| File | Change |
| --- | --- |
| `AGENTS.md` | One bullet under "Database" |
| `prek.toml` | One hook entry |
| `scripts/check-migrations-strict.mjs` | New file (~50 LOC) |

## Cost / Impact / Risk

| | |
| --- | --- |
| Cost | S (~1h: write hook, write AGENTS.md sentence, test on the existing migrations to confirm the hook doesn't false-positive) |
| Impact | Medium long-term — every future schema bug from type coercion is prevented. Zero immediate user-visible impact. |
| Risk | Low. Worst case: a contributor gets confused, looks up the AGENTS.md note, fixes the migration. |

## Testing

- Run `prek run check-migrations-strict --all-files` and confirm it doesn't false-positive on existing migrations (which all skip the rule because they're pre-policy).
- Confirm it does fail on a deliberately-bad new migration (test by creating a temp `.sql` file, running, then deleting).
- Confirm it correctly skips `CREATE VIRTUAL TABLE` (test against `0002_fts5.sql`).

## Open questions

- Should the hook ALSO retro-flag existing migrations? **No** — that defeats the "retrofit is too expensive" rationale. Existing migrations are immutable per the existing `migrations-immutable` hook, so the check applies *to new files only*. The hook's `files` regex catches any change in the directory, but its parser only flags newly-added `CREATE TABLE` statements (or modified ones, but `migrations-immutable` already prevents modification).

- Should we also enforce other modern SQLite features (`WITHOUT ROWID`, `GENERATED ALWAYS`, etc.)? **No** — those are case-by-case optimizations. STRICT is universal, the others aren't. Don't conflate.
