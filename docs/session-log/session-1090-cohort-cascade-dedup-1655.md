# Session 1090 — /batch-issues loop: cohort cascade SQL dedup + drift guards, batch 36 (2026-06-20)

## What happened

Maintainability fix from the morning `/loop /batch-issues` continuation, built in
worktree `wt-1655` and adversarially reviewed. A heterogeneous-dedup problem handled with
the #1661 lesson firmly in mind (extract what's cleanly shareable; guard the rest; never
force a worse representation or convert compile-time macros to runtime SQL).

## Shipped

PR `fix/cohort-cascade-dedup-1655`:

- **#1655** (LOW, maintainability) — the "walk descendant cohort then UPDATE/SELECT"
  cascade SQL was reimplemented across 5+ sites, aligned only by prose comments + parity
  tests. After mapping every site, most were ALREADY deduplicated onto the shared
  `descendants_cte_*!()` macro family in `block_descendants.rs`. The remaining duplication
  was handled per its nature:
  - **Clean extractions** (2 runtime sites that re-inlined a macro-able CTE body now
    consume `descendants_cte_purge!()` via `concat!`): `materializer/handlers/loro_apply.rs`
    (the purge `CREATE TEMP TABLE _purge_descendants` walk) and `commands/blocks/crud.rs`
    (single-root purge cohort capture). Both produce byte-identical SQL; neither changes
    the runtime-`sqlx::query(` count (#646 baseline untouched).
  - **Kept as-is (genuinely un-shareable):** `apply.rs::collect_purge_affected_pages` +
    `soft_delete::trash::cascade_soft_delete` use compile-time `sqlx::query!` (which
    requires a string literal and rejects `concat!` of a macro — converting them to
    runtime SQL was explicitly out of bounds, the #1661 lesson); the crud.rs MULTI-root
    delete/restore/purge CTEs seed from `json_each(?1)` (+ per-root `root_deleted_at`), a
    shape the single-root `id = ?` macro can't express.
  - **Drift guard** (the real deliverable for the un-extractable sites; mirrors
    `space_filter_canonical`): a `cohort_cascade_drift_guard` module in
    `block_descendants.rs` with a whole-crate `src/**/*.rs` walk asserting EVERY
    `descendants d` recursive arm carries the `d.depth < 100` cap, per-macro-variant
    `deleted_at` filter pins (active `IS NULL`, cohort `= ?`, standard/purge none), and a
    multi-root `json_each` anchor + cohort-filter + cap pin against crud.rs.

## Review pass

Reviewer (APPROVE, no defects): reconstructed the `descendants_cte_purge!()` expansion and
confirmed both `concat!` extractions are CHARACTER-for-character byte-identical to the
prior inlined SQL (CTE body, depth-100 cap, no `deleted_at` filter, trailing SELECT, single
bind). Verified the "kept as-is" justifications are real (it even checked additional sites
the builder's narrative didn't name — `block_cleanup.rs`, `pages_cache.rs`, `db/recovery.rs`
— and confirmed none could byte-identically share without an SQL-text change or a
macro→runtime conversion). Mutation-verified all 3 guards (depth `<100`→`<50`, active arm
`IS NULL`→`= ?`, multi-root cap all fail their respective guard), and confirmed the
`≥5`-arm floor catches a broken anchor regex. No macro→runtime conversion; #646 baseline
untouched; 475 + 123 targeted cohort/cascade tests pass; clippy clean; no over-reach (3
files).

## Notes

- Non-blocking cosmetic: the module doc's example-site list and the new guard doc-comment's
  example-site list name different sites — the guard is whole-crate and site-list-
  independent, so correctness is unaffected (left for a future one-line reconciliation).
- Files: `block_descendants.rs` (+guard), `commands/blocks/crud.rs`,
  `materializer/handlers/loro_apply.rs`. No `.sqlx`/baseline change.
- Branch base is current `origin/main`.
