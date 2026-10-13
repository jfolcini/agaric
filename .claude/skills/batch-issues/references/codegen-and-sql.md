# Codegen and SQL regeneration

Run after the matching Rust change and before committing.

## sqlx `.sqlx/` caches

Any `query!` / `query_as!` / `query_scalar!` change, including a column-type override or moving one between crates: `just gen-sqlx` (why not bare `cargo sqlx prepare`: the recipe's comment in `justfile`), then stage all four caches. A `FromRow` field change needs no regen. The regen needs a `dev.db` that matches the branch (`pitfalls.md`).

Only CI's four `prepare --check` lanes and, partially, the `check-sqlx-cache-drift` hook catch a wrong-scope prune. The hook judges the staged index, so stage all four caches before trusting it: a half-staged regen reads as drift, and an unstaged one reads as clean.

After every regen, read `git status --short src-tauri/.sqlx src-tauri/*/.sqlx`. A mass deletion is a wipe (wrong scope, a stale `dev.db`, or another cargo build holding the lock), not a cleanup: restore those directories from `HEAD` and re-run with nothing else building.

`prepare --check` exiting 0 with "potentially unused queries found in .sqlx" is not clean: the cache holds entries no query produces. Regenerate.

To share SQL between `query!` sites, keep each macro's literal and add a test asserting the copies agree. Converting to runtime `sqlx::query` to share a `const` trades a compile-time check for a dynamic-SQL baseline entry.

## specta bindings

`just gen-bindings` (when, in `AGENTS.md` § TypeScript Bindings) exceeds the 10-minute foreground limit: run it as a background task.

## Migrations

Rules and the rebuild recipe: `src-tauri/migrations/AGENTS.md`. Before a column-type migration, read the coupled-column pitfall in `pitfalls.md`.
