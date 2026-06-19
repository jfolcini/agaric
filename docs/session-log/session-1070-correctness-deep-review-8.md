# Session 1070 — /batch-issues loop: correctness, batch 21 (2026-06-19)

## What happened

Twenty-first batch of the night `/loop /batch-issues` run, built in worktree
`wt-batch21`, overlapped with backend batch 19 and SafeLimit batch 20. Three findings
were attempted; one (#1661) was dropped after adversarial review (see below), so the
PR ships two: a backend TOCTOU fix and a frontend cache-staleness fix.

## Shipped

PR `fix/correctness-deep-review-8`:

- **#1551** (LOW, correctness) — `restore_page_to_op_inner` computed the ops-to-revert
  set with `.fetch_all(pool)` BEFORE `revert_ops_inner` opened its `BEGIN IMMEDIATE`,
  so an op landing between the read and the write (concurrent edit / sync replay) was
  excluded yet kept its forward effect (TOCTOU window). Split `revert_ops_inner` into
  an open/commit shell + a `revert_ops_in_tx(tx, …)` body, and lifted the membership
  SELECT (both the `__all__` global-scope branch and the per-page recursive CTE) INTO
  the same IMMEDIATE write tx via `.fetch_all(&mut **tx)`. Because `BEGIN IMMEDIATE`
  takes the write lock up front, a concurrent writer is now serialized strictly before
  the read or strictly after commit — never in the old gap. Behavior otherwise
  identical (same ops, newest-first sort, reverse logic, `UndoResult`s, enqueue→commit
  →dispatch order); the target `created_at` read stays ahead of the tx (immutable
  already-committed op). L-31 doc-block updated.
- **#1818** (FE bug, #1530 follow-up) — the graph cache served stale data after a
  remount within the 5-min TTL when a page/`[[link]]` was created while `GraphView`
  was unmounted. Root cause: the invalidation signal was a per-component
  `useState(0)` in `useBlockPropertyEvents` that reset on every mount, while
  `graphCacheMap` is module-level. Hoisted the counter + the Tauri listener to a
  module-level store (`src/lib/block-property-events.ts`, debounced 150 ms, lazily-
  registered process-lifetime listener gated on `__TAURI_INTERNALS__`), made the hook
  a thin `useSyncExternalStore` adapter (public API `{ invalidationKey }` unchanged),
  and stamped each `GraphCache` entry with the `invalidationKey` it was fetched at so
  a stale entry triggers a refetch. Mirrors the existing `property-keys-cache.ts`
  convention. The #1530 on-screen refetch path is preserved.

## Dropped after review — #1661

#1661 (dedup the fast-path candidate-clause SQL vs `resolve.rs`) was attempted via a
single-source extraction, but that required converting the resolver's compile-checked
`query_scalar!` macros to runtime `query_scalar(AssertSqlSafe(...))` — sqlx macros need
a string literal and can't consume a shared `const`. The adversarial reviewer (with
decision authority) flagged this as net-negative: it deletes compile-time schema
validation on a security-relevant resolver and regresses the #646 dynamic-SQL guard
(`resolve.rs` 2→4 runtime sites, no baseline bump) — a poor trade for a LOW
maintainability win. Reverted; left the issue an informed comment recommending
Approach 2 (keep the macros, add only a drift-guard test) as a focused follow-up.

## Review pass

- **#1551** reviewer verified the tx lifecycle on every return path (no leaked
  IMMEDIATE write lock; correct single commit; rollback on empty/over-large/error),
  atomicity on both membership branches, and behavior-preservation of the
  `revert_ops_in_tx` extraction. It found the regression test inadequate (mutation:
  reverting the SELECT to the pool still passed) and honestly reframed its doc comment
  as a behavior-preservation guard — a deterministic single-process TOCTOU test isn't
  feasible without an injectable seam; the production fix is sound as-is. 200 tests pass.
- **#1818** reviewer confirmed the hook's public API is stable across all consumers
  (DonePanel, AgendaResults, LinkedReferences, JournalCalendarDropdown, useDuePanelData,
  useBatchProperties), traced the unmount→mutate→remount-within-TTL refetch, verified
  the listener lifecycle (no double-register, gated for jsdom), the trailing-edge
  debounce, and `useSyncExternalStore` snapshot stability. 53 + 195 tests, tsc clean.

## Notes

- Files: `commands/history.rs`, `commands/tests/undo_redo_tests.rs` (#1551);
  `lib/block-property-events.ts` (new), `hooks/useBlockPropertyEvents.ts`,
  `components/graph/GraphView.tsx` + their tests (#1818).
- Branch base (`58dff693`) is current `origin/main`.
