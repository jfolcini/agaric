# Codegen and SQL regeneration

Run after the matching Rust change and before committing; CI and the pre-push clippy fail on stale generated artifacts.

## sqlx `.sqlx/` caches

Any change to a `query!` / `query_as!` / `query_scalar!` (including a column-type override): **`just gen-sqlx`**, then stage all four caches (root, `agaric-store`, `agaric-engine`, `agaric-sync`).

Never the bare `cargo sqlx prepare`. sqlx's `--workspace` flag chooses where the cache is written; cargo's `-- --workspace --tests` after the `--` chooses what is built. The bare command builds only the default member as a plain lib, so it drops leaf crates and every member's test-only queries, and prunes the entries it did not observe. `just gen-sqlx` runs the correctly scoped root pass plus one pass per member crate against a throwaway migrated DB.

Nothing local complains about a wrong-scope prune except CI's four `prepare --check` lanes and, partially, the `check-sqlx-cache-drift` hook, which judges the staged index. So stage all four caches before trusting it: a half-staged regen reads as drift, and an unstaged one reads as clean.

A `FromRow` field change needs no regen. A query-macro change does, and needs a live `dev.db` that matches the branch (see `pitfalls.md`).

## specta bindings

Any change to a command signature, an arg/return type, the command list, or the `///` docs on any of them: `cd src-tauri && cargo test -- specta_tests --ignored` (or `just gen-bindings`) and commit `src/lib/bindings.ts`.

## Migrations

Rules and the rebuild recipe: `src-tauri/migrations/AGENTS.md`. Before a column-type migration, read the coupled-column pitfall in `pitfalls.md`.
