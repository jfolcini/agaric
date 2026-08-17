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

First, the flag that trips everyone up: `cargo sqlx prepare --workspace` and
`cargo sqlx prepare -- --workspace` are **different things**. The first is sqlx's own
flag and selects where the cache is *written*; cargo's build *scope* comes from the args
after the `--`. `just gen-sqlx` passes both (`--workspace -- --workspace --tests`), and
that placement is the whole point.

1. **The three member-crate caches are never written, so they go stale.** `agaric`
   path-depends on all three, so their queries *are* observed by the root pass and land
   in the root cache — but each crate also keeps its own cache, and only a pass run from
   inside that crate writes it. This is the failure you hit by following the old advice.
2. **Without cargo's `--workspace`, entries get pruned for want of scope.** `prepare`
   deletes any entry it does not *observe*, and observation follows what actually built.
   Two things go unbuilt: leaf crates nothing depends on (`diagnostics` — the
   missing-`default-members` effect, `src-tauri/Cargo.toml`, #3212), and the member
   crates' **test-only** queries, because `-- --tests` applies to the `agaric` package
   while path-dep members build as plain libs, so their `#[cfg(test)]` `query!` sites
   never recompile. That second one is what pruned 86 of 615 root entries in #4095.
   Session-1310 records the same shape: a bare `cargo sqlx prepare --workspace` (sqlx's
   flag only, no cargo scope) pruned 260 root entries, "it only sees the root crate's
   queries".
3. **Residually, a warm tree can still under-observe.** Even correctly scoped, `prepare`
   only sees what recompiled. This is the general caveat
   `scripts/check-sqlx-cache-drift.sh:5-14` exists to catch, and the reason to read a
   `.sqlx` diff rather than assume a green command means a correct cache.

Nothing local complains about 1 or 2: `cargo sqlx prepare --check -- --tests` re-checks
the same narrow scope it just wrote — and tolerates a superset cache — so it exits 0, and
`cargo check` stays green because the live DB puts sqlx in online mode. Only CI's offline
lanes notice, in a different crate's cache than the one you touched. See #3901 for the
incident history, and #4095 for the one caused by this file's own previous advice.

`just gen-sqlx` is not simply "add `--workspace`" — it runs the correctly-scoped root pass
**plus** one pass per member crate against its own throwaway migrated DB, which is what
covers 1 and 2. For 3, `scripts/check-sqlx-cache-drift.sh` is the guard.

**`git add` all four caches before trusting that guard**, and know which way it fails if
you don't. It judges the staged **index**, not the working tree (there is also a
`--range` mode, used only by the pre-push verifier `verify-ci-equivalent.sh` — CI never
invokes this script; CI's net for this shape is the four `prepare --check` lanes). So
after a full-tree `just gen-sqlx`, partial staging goes wrong in *both* directions:

- Stage one cache's deletion while a sibling's identical entry is still tracked in the
  index → the guard sees a live sibling and fires **red**, which reads as genuine
  cross-cache drift but is really just partial staging. Its self-test builds exactly this
  case.
- Leave a cache's deletions entirely unstaged → the guard never sees them and reports
  **green**, while the stale cache sits in your working tree waiting to fail CI. This is
  the one that actually bit in #4095.

See AGENTS.md § Key
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
