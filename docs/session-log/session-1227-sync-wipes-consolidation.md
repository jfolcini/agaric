# Session 1227 — Sync snapshot wipes behind owner crates (#2895 slice 4)

**Issue:** #2895 (slice 4)

## What

agaric-sync's five snapshot wipe/compaction raw writes (all inside the restore/create
IMMEDIATE tx) moved behind owner-crate fns, SQL byte-identical, no nested tx:

- `agaric_store::cache::truncate_block_links(conn)`
- `agaric_engine::block_ops::truncate_all_blocks(conn)` and
  `null_orphan_space_ids(conn)` (predicate byte-for-byte; returns rows-affected so
  the caller's #708 warn stays verbatim)
- `agaric_store::op_log::truncate(conn)` and `prune(conn, created_before, device_id,
  max_seq)` — both ENCAPSULATE the migration-0036 trigger bypass
  (enable → DELETE → disable inside the caller's tx), so callers can no longer
  forget the bracket or leak the sentinel.

## Review (adversarial, independent agent): SHIP, zero fixes

- Per-call bracketing (prune) proven behaviorally equivalent to the old
  loop-wide bracket: nothing runs between iterations, and the post-loop
  cleanup writes log_snapshots (outside the old window too).
- sqlx offline compile proven green including --all-targets (the workspace-level
  cache already holds the byte-identical hashes).
- Byte-equivalence of all five statements verified verbatim; wipe order unchanged
  (moot under defer_foreign_keys anyway); the retained public bypass pair is still
  used by test fixtures.
- LOW latent flag (documented, non-blocking): a mid-helper error leaves the
  sentinel INSERTed within the failing tx; safe today because every caller
  propagates via `?` (tx rollback discards it) — a future catch-and-continue
  caller would need a scopeguard hardening.

## Baseline

All 3 sync pairs ELIMINATED (+ orphaned group header removed); annotations intact.
The sync crate now has zero cross-crate raw writes.

## Verification

Builder: 335 targeted + 4 bypass unit tests (incl. two new encapsulation tests:
bare truncate succeeds on the triggered DB and leaves the sentinel cleared;
prune respects the seq bound). Reviewer: 1819/1819 across the three crates,
offline checks, clippy clean. Post-rebase: offline workspace check + 276
snapshot/bypass/restore tests green.
