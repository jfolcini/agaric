# Session 1223 — Explicit ApplyMode replaces the replay-suppression global (#2896)

**Issue:** #2896 (arch-backend deep-review family)

## Problem

`LoroState.replay_suppress_reproject` (AtomicBool + companion Mutex<HashSet>) changed
apply semantics process-wide during boot replay; soundness rested entirely on a
comment-enforced quiescence invariant ("nothing else applies ops during the window").
A future concurrent applier would silently inherit suppression and leak (or lose) its
reprojection.

## Fix

Mode is now explicit in the call graph — no ambient global:

- `ApplyMode { Normal, ReplaySuppressed(ReplayDirtyParents) }` in
  `agaric-engine/src/apply/kernel.rs`; the sink is an Arc<Mutex<HashSet>> newtype
  (a `&mut` borrow can't cross the async foreground queue — ops apply on the
  consumer task).
- Wrapper pattern keeps all 83 existing callers unchanged on Normal
  (`apply_op_tx` → `apply_op_tx_with_mode`, same for `apply_op_projected`/`apply_op`).
- New `MaterializeTask::ReplayApplyOp(record, sink)` — constructed only by the boot
  replay driver; identical to ApplyOp in dedup/retry/metrics/cursor. The driver owns
  the sink, drains + reprojects after `flush_foreground`, then drops it.
- The AtomicBool, companion set, five methods, and the quiescence-invariant comment
  are deleted (0 references).

## Review (adversarial, independent agent): SHIP

The one true behavior question — ops entering the queue mid-replay now reproject
inline instead of being suppressed — answered definitively: **no non-replay op can
reach the queue during the window on any reachable boot path** (retry sweeper, sync
daemon, draft recovery all start strictly after replay's flush), and replay ops
derive sibling order from the Loro engine, never from SQL positions, so an inline
reproject cannot perturb later replay ops (reproject is idempotent, write-only).
On the previously-unreachable concurrent path the new code is strictly safer: the
old design would have leaked the concurrent applier's reprojection into replay's
set and LOST it on an aborted replay (the guard cleared the flag without draining).
One LOW doc-severance fix applied in review (ChunkAccumulator's safety doc had been
orphaned onto a new type alias).

## Tests

New `apply_op_tx_normal_mode_ignores_active_replay_sink_2896` — non-vacuous: under
the old global design both assertions (inline dense positions [1,2]; live sink stays
empty for Normal ops) are inexpressible/failing. Plus the full load-bearing suites.

## Verification

`cargo check --workspace` clean; nextest recovery/replay/reproject/apply → 289
passed; recovery_kernel_parity → 8; engine_path → 14 (incl. new test);
`cargo clippy --workspace --tests` no warnings; grep for all removed identifiers → 0.
