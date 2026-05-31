# Codegen & SQL regeneration

Run these after the matching kind of Rust change, BEFORE committing — otherwise CI (or
the pre-push clippy) fails on stale generated artifacts.

## sqlx `.sqlx` offline cache

If a Rust change touches SQL queries (`query!`/`query_as!`, or an
`as "col!: NewType"` override), regenerate the cache:
`cargo sqlx prepare -- --tests`.

A type-only `FromRow` *field* change does NOT need regen. A query-macro change (incl. a
column-type override) DOES, and needs a live DB — see the dev.db note in
`references/pitfalls.md` when branches have divergent migrations.

## Tauri/specta bindings

If a Rust change touches types used in Tauri commands, regenerate `src/lib/bindings.ts`:
`cd src-tauri && cargo test -- specta_tests --ignored`.

## SQL migration deep recipe

See the timestamp/enum-column coupling pitfall in `references/pitfalls.md` before any
column-type migration: grep the column for cross-table `> ?` / `< ?` predicates, migrate
coupled clusters in one PR, and use the ms-precision backfill
`CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`.

## Architectural invariants (AGENTS.md)

Respect: append-only op log, event sourcing + materialized views, cursor pagination,
single TipTap instance (per-BlockTree, not app-wide), Biome/oxc only, sqlx compile-time
queries, foreign keys ON, ULID uppercase normalization.
