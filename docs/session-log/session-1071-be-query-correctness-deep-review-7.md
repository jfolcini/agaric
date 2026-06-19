# Session 1071 — /batch-issues loop: backend query correctness, batch 19 (2026-06-19)

## What happened

Nineteenth batch of the night `/loop /batch-issues` run, built in the main checkout,
overlapped with SafeLimit batch 20 and correctness batch 21. Two disjoint backend
findings — one pagination-correctness robustness fix, one write-path perf fix — each
adversarially reviewed.

## Shipped

PR `fix/be-query-correctness-deep-review-7`:

- **#1555** (LOW, robustness) — `list_children` ordered/walked its keyset on raw
  `position`, while `get_page_inner` wraps the keyset and `ORDER BY` in
  `COALESCE(position, NULL_POSITION_SENTINEL)`. A genuine NULL position could
  mis-order or drop rows across a pagination boundary (latent: today's write path
  binds non-NULL, migration 0024 backfilled). Brought `list_children` into exact
  parity — `COALESCE(position, ?7)` on both sides of the keyset comparison and the
  `ORDER BY`, binding the same `NULL_POSITION_SENTINEL` (`i64::MAX`) constant
  `get_page_inner` uses. New test inserts a genuine NULL position and paginates across
  the boundary, asserting the NULL row sorts at the sentinel and is not dropped.
- **#1627** (LOW, perf) — each of the 6 property-write commands called
  `verify_active(pool, …)` — a standalone indexed pool round-trip — purely to mint the
  `ActiveBlockId` type-state and to distinguish missing (`NotFound`) from soft-deleted
  (`Validation`), while the inner write tx then re-validated the same row with
  `AND deleted_at IS NULL` collapsing both cases. Pushed the discrimination INTO the
  existing in-tx read: dropped the `deleted_at IS NULL` filter from `set_property_in_tx`
  / `delete_property_core` step-2 and discriminate on the fetched `deleted_at`; the 6
  wrappers now mint `ActiveBlockId::from_trusted_active(...)` cheaply. One fewer pool
  round-trip per write, the row read exactly once in-tx (also more TOCTOU-correct), and
  command-boundary error variants/messages byte-identical. The MCP path keeps the
  pool-form gate intentionally (no surrounding tx). Added `verify_active_in_tx`.

## Review pass

- **#1555** reviewer confirmed exact mirror-parity with `get_page_inner` (COALESCE on
  both keyset sides + ORDER BY, same sentinel/direction), cursor parity
  (`unwrap_or(NULL_POSITION_SENTINEL)` matches the SQL), and mutation-proved the new
  test FAILS under the raw-`position` form (SQLite sorts NULL first → wrong page-1).
  The `i64::MAX` collision is the pre-existing accepted contract, no new hazard.
- **#1627** reviewer built a per-caller error blast-radius table: every caller of
  `set_property_in_tx` / `delete_property_core` is command-side and propagates via `?`;
  the sync-replay / op-apply / reproject / materializer paths route through
  `apply_*_to_sql` and do NOT touch the changed functions, so the `NotFound`→
  `Validation` discrimination change for a soft-deleted block at `_inner` level is
  fully contained (no NotFound-swallowing caller). Verified command-boundary parity,
  `from_trusted_active` soundness, the round-trip is gone, and owned the `.sqlx`
  verification: canonical `cargo sqlx prepare -- --tests` shows the net delta is
  exactly the #1555 list_children swap (554 entries, no test-only pruning; #1627's
  queries reuse pre-existing cache hashes). `clippy --all-targets -- -D warnings`
  clean; 515 targeted tests pass.

## Notes

- Files: `pagination/hierarchy.rs`, `pagination/tests.rs` (#1555);
  `commands/properties.rs`, `commands/mod.rs`, `domain/block_ops.rs`, `ulid.rs`,
  `commands/tests/property_cmd_tests.rs`, `command_integration_tests/property_integration.rs`
  (#1627); one `.sqlx` entry swapped (old non-COALESCE list_children → new COALESCE).
- `.sqlx` gotcha recorded by the reviewer: a concurrent `cargo` build holding the
  target lock can make `cargo sqlx prepare` emit a stale (wrong) delta; regenerate only
  when no other build holds the lock.
- Branch base (`58dff693`) is current `origin/main`.
