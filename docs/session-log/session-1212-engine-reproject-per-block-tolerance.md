# Session 1212 — Engine-reproject per-block failure tolerance (#2920)

## Issue
#2920 — On engine-first boot recovery, `reproject_blocks_from_engine`
(`src-tauri/src/db/recovery.rs`) reprojected every space's blocks inside ONE shared
transaction. A single block's engine-read or SQL-projection error propagated via `?` and
rolled back **all** spaces. Combined with the this-boot-only gate (the `blocks` table
exists again next boot, so the pass is skipped) and the #616 pending marker being cleared
before this pass runs, a partial failure meant **permanent, silent, unlogged data loss**.

## What shipped
Per-block failures are now non-fatal (skip + `error!`-log, isolated by a SAVEPOINT) so
good blocks and whole other spaces still commit, AND a dedicated retry marker is armed so a
partial recovery is retried on the next boot instead of being silently forgotten.

## Implementation
- `src-tauri/src/db/recovery.rs`:
  - New `ENGINE_REPROJECT_PENDING_KEY` (`recovery.engine_reproject_pending`) — **distinct**
    from the #616 `DERIVED_RECOVERY_PENDING_KEY`, which `recover_derived_state_from_op_log`
    clears *before* the reprojection runs; reusing it would let the derived pass wipe this
    retry signal. Helpers: `set_engine_reproject_pending(exec, pending)` (generic over
    executor — writes atomically inside the tx or standalone against the pool) and
    `engine_reproject_pending(pool)` (boot-path gate, guarded on `app_settings` existence →
    `Ok(false)` on a fresh DB, no boot panic).
  - `reproject_blocks_from_engine`: engine reads and SQL passes made non-fatal, mirroring
    the existing per-space decode-skip. Bulk `read_blocks_bulk` fast path falls back to
    per-block `read_block` on bulk failure to isolate the corrupt block(s). Pass A (core)
    runs each block under its own SAVEPOINT (`tx.begin()`, `use sqlx::Acquire`); Pass B/C/D
    per block under one savepoint. A failing block rolls back only its savepoint, is logged
    with `space_id`+`block_id`+`error`, flagged `skipped`, and excluded from **every** later
    pass; the shared tx stays intact. FK ordering is safe — the reprojection path runs
    `foreign_keys=ON` **without** `defer_foreign_keys`, so a violation aborts at statement
    time inside the savepoint, not at the outer commit.
  - Retry-gate: on any skipped space/block, `set_engine_reproject_pending(&mut *tx, true)`
    is written **atomically with the committed content**; a fully-clean run clears it. The
    all-decode-failed path (`spaces_reprojected == 0`, returns `Ok(false)`) arms the marker
    via the pool after the empty tx rolls back. Summary logs at `error!` with skipped counts
    when partial, `warn!` (unchanged #2504 message) when clean.
- `src-tauri/src/db/pool.rs`: both boot sites (`init_pools`, `init_pool`) now gate on
  `blocks_recovered || engine_reproject_pending(&pool).await?` — the fix for the
  silent-permanent-loss trap, since `blocks_recovered` is this-boot-only.

## Tests (`recovery.rs`, all `multi_thread`)
Failure injection: a remote block with an unrecognized `block_type` (`"garbage"`) passes
the engine read but aborts its Pass A INSERT on the `blocks.block_type_valid` CHECK
(migrations 0085/0089) — a faithful un-projectable-remote-block stand-in, isolated to one
block.
- `engine_reproject_tolerates_bad_block_commits_good_content_and_arms_retry_2920` — bad
  block in space-1 (plus a valid page+child), space-2 fully valid: asserts the page/child
  AND all of space-2 commit, the bad block is absent, retry marker armed.
- `engine_reproject_clean_clears_retry_marker_2920` — pre-armed marker cleared on a clean run.
- `engine_reproject_tolerates_corrupt_space_and_arms_retry_2920` — per-space decode tolerance
  still holds; valid space commits, marker armed.
- `engine_reproject_all_snapshots_corrupt_returns_false_and_arms_retry_2920` — all-decode
  failure returns `Ok(false)` but still arms the retry.

## Verification
Independent adversarial review (strong model) confirmed savepoint isolation (per-block
rollback only), the distinct-marker necessity (the #616 key is cleared pre-pass), atomic
in-tx marker writes, both boot-gate sites, faithful non-vacuous failure injection, and
complete assertions. `cargo nextest -E 'test(recovery) or test(reproject) or test(2920) or
test(engine_first) or test(corrupt)'` → **137 passed, 3192 skipped**; clippy
`-p agaric --lib --all-targets` clean; `fmt --check` clean; only the two intended files
changed, no Serena/edit leaks into the main checkout.
