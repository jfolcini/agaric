# Session 1205 — Debounce the local-lifecycle full-vault rebuild fan-out

**Date:** 2026-07-23
**Branch:** `perf/lifecycle-rebuild-debounce`
**Closes:** #2935, #2937

## Summary

A burst of local lifecycle ops (multi-select delete, trash sweep, bulk cleanup) re-ran the
8-9-task global full-vault rebuild set once **per op**: the existing dedup at
`dispatch.rs` only collapses duplicates *within a single drained batch*, and sequential local
ops land in separate drains. Each global rebuild takes its own `BEGIN IMMEDIATE` writer tx,
serializing against foreground typing. The inbound-sync path already solved the identical
problem in #2291 with a trailing debounce; this extends the same machinery to the local
lifecycle path.

## The change (`materializer/coordinator.rs` + `dispatch.rs`)

- **Second `InboundRebuildDebounce` instance** (`lifecycle_rebuild_debounce`) on `Materializer`
  — reusing the existing struct, not a new type — plus a generic `rebuild_debounce_loop(mat,
  debounce, fire_fn)` driver that both the inbound and lifecycle loops bind (the trailing-window /
  max-wait / seq-ABA-guard logic now lives once). The 300 ms window / 2 s max-wait constants are
  shared.
- **Targeted tasks stay inline.** In `enqueue_background_tasks`, for `DeleteBlock`/`RestoreBlock`/
  `PurgeBlock` only, tasks whose discriminant is in `FULL_CACHE_REBUILD_TASKS` (the 9 argument-less
  globals) are routed to the debounce arm, while per-block `RemoveFtsBlock`/`UpdateFtsBlock` (which
  carry a `block_id`) remain enqueued inline via `try_enqueue_background`. Non-lifecycle ops are
  untouched.
- **FULL-vs-CONTENT fidelity (#2042 preserved).** A `needs_full` flag on `DebounceState` is
  OR-accumulated across the burst: a pure content-block burst fires the narrowed
  `CONTENT_LIFECYCLE_REBUILD_TASKS` (a strict subset of FULL); any non-content op in the burst
  escalates the single fire to `FULL_CACHE_REBUILD_TASKS` (union always correctness-safe). Reset to
  `false` on disarm; the inbound instance never sets it.
- **Drain contract preserved.** `flush_background()` calls `fire_pending_lifecycle_rebuild()`
  before the barrier (and `flush()` routes through it), so every explicit drain / `settle` closes
  the staleness window exactly as pre-#2935.

## Staleness soundness

These 9 rebuilds have been **asynchronous background-queue tasks since #2042** (which moved the
pages-cache count recompute off the synchronous foreground path). The delete/restore/purge apply
tx still mutates the source-of-truth tables (`blocks`, FK cascades, `op_log`) synchronously;
correctness-critical logic reads those, not the derived caches. #2935 only *coalesces* the
already-background enqueues, widening the eventual-consistency window by ≤300 ms (cap 2 s) — the
same bounded staleness the inbound path already tolerates. No read-after-write guarantee changed.

## #2937 (doc only)

`cache/pages.rs` — rewrote the stale `rebuild_pages_cache_counts` doc that claimed "enqueued ONLY
on the snapshot/sync RESET path"; it now lists the three actual enqueue sites (every local
lifecycle op via this debounce, the #2291 inbound fan-out, RESET) and names the `dispatch.rs`
matrix as the single source of truth.

## Tests

`local_lifecycle_rebuild_debounce_coalesces_delete_burst` (`materializer/tests/cache_rebuild.rs`,
multi-thread tokio, real time + `settle()`): seeds 5 content blocks each with an `fts_blocks` row,
dispatches 5 back-to-back `DeleteBlock` ops, and asserts (1) mid-burst `fanout_fires == 0`, (2)
after the window `fanout_fires == 1` (5 ops → one global fan-out), (3) all 5 `fts_blocks` rows
gone — proving the inline per-block `RemoveFtsBlock` still ran (the global set never touches FTS).
**Non-tautological:** disabling the arm makes assertion 2 fail (`0 != 1`) — verified by builder and
independently by the reviewer. One existing backpressure test
(`enqueue_full_cache_rebuild_under_backpressure_increments_bg_dropped`) gained a
`fire_pending_lifecycle_rebuild()` call to reflect the new enqueue timing; its `>= baseline + 7`
assertion is unchanged.

## Verification

Independent adversarial review confirmed the staleness window introduces no new read-after-write
hazard (drain contract preserved, full conformance/convergence suite green), `is_global_lifecycle_
rebuild` discriminant precision, `needs_full` union-safety + reset, byte-equivalent inbound loop
(#2291 preserved), lock discipline (no lock held across await/enqueue), and the modified test's
legitimacy. `cargo nextest` (agaric-store + materializer) **371 passed, 0 failed**; `cargo clippy
--workspace --lib --tests -D warnings` clean; `cargo fmt --check` clean.
