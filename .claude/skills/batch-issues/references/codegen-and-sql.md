# Codegen & SQL regeneration

Run these after the matching kind of Rust change, BEFORE committing — otherwise CI (or
the pre-push clippy) fails on stale generated artifacts.

## sqlx `.sqlx` offline cache

If a Rust change touches SQL queries (`query!`/`query_as!`, or an
`as "col!: NewType"` override), regenerate the caches: **`just gen-sqlx`**.

Never the bare `cargo sqlx prepare -- --tests`. There are **four** caches (root +
`agaric-store` / `agaric-engine` / `agaric-sync`), each checked by its own CI lane, and
the bare command produces three distinct failures. Keep them separate — conflating them
is what makes people think one extra flag is the fix:

1. **The three member-crate caches are never written, so they go stale.** `agaric`
   path-depends on all three, so their queries *are* observed by the root pass and land
   in the root cache — but each crate also keeps its own cache, and only a pass run from
   inside that crate writes it. This is the failure you hit by following the old advice.
2. **Entries get pruned by a partial or warm-tree recompile.** `cargo sqlx prepare`
   deletes any entry it does not *observe*, and what it observes is whatever actually
   recompiled. This fires **even with `--workspace`** — session-1310 records a bare
   `cargo sqlx prepare --workspace` from `src-tauri/` pruning 260 root entries. Adding
   the flag does not protect you.
3. **Leaf crates nothing depends on are dropped.** This is the missing-`default-members`
   effect (`src-tauri/Cargo.toml`, #3212), and it bites `diagnostics` — not the three
   above. The symptom is the offline `cargo clippy --workspace --all-targets` lint job
   reddening on the next non-docs PR.

Nothing local complains about any of them: `cargo sqlx prepare --check -- --tests`
re-checks the same narrow scope it just wrote and exits 0, and `cargo check` stays green
because the live DB puts sqlx in online mode. Only CI's offline lanes notice, in a
different crate's cache than the one you touched. See #3901 for the incident history,
and #4095 for the one caused by this file's own previous advice.

`just gen-sqlx` is not simply "add `--workspace`" — it runs the workspace-wide root pass
**plus** one pass per member crate against its own throwaway migrated DB. That covers 1
and 3. Nothing fully prevents 2, which is why `scripts/check-sqlx-cache-drift.sh` exists
as a guard — but note it inspects the **staged diff**, so it can only judge what you
actually staged: `git add` all four caches before trusting it. See AGENTS.md § Key
Architectural Invariants #6 for the full shape.

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
