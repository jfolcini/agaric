# Codegen & SQL regeneration

Run these after the matching kind of Rust change, BEFORE committing — otherwise CI (or
the pre-push clippy) fails on stale generated artifacts.

## sqlx `.sqlx` offline cache

If a Rust change touches SQL queries (`query!`/`query_as!`, or an
`as "col!: NewType"` override), regenerate the caches: **`just gen-sqlx`**.

Never the bare `cargo sqlx prepare -- --tests`. This workspace has no
`default-members` (see `src-tauri/Cargo.toml`), so that command resolves to the single
`agaric` package — every cache entry belonging to a query in `agaric-store` /
`agaric-engine` / `agaric-sync` is then unobserved, looks orphaned, and is **silently
pruned**. Nothing local complains: `cargo sqlx prepare --check -- --tests` re-checks the
same narrow scope it just pruned and exits 0, and `cargo check` stays green because the
live DB puts sqlx in online mode. Only CI's offline lane notices, in a different crate's
cache than the one you touched. This has now happened four times (#3901 records 83, 260
and 273 pruned entries; a fourth run following *this file* pruned 86).

`just gen-sqlx` is not simply "add `--workspace`" — it runs the workspace-wide root pass
**plus** one pass per member crate against its own throwaway migrated DB, because all four
caches are checked by their own CI lanes. See AGENTS.md § Key Architectural Invariants #6
for the full shape, and `scripts/check-sqlx-cache-drift.sh` for the guard.

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
