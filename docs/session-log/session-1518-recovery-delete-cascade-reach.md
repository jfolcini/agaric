# Session 1518 — recovery's live-row cascades adopt the engine's `Active` reach

Issue #4233. Recovery's delete cascade descended *through* an already-tombstoned child and
pruned only the write (`WHERE deleted_at IS NULL`); the engine's `project_delete_block_to_sql`
prunes the **walk** (`DescendantWalkFilter::Active`). So a live block under a tombstone got
this op's cohort from recovery and stayed `NULL` under the engine.

## Why the write guard was not enough

The two answers are not interchangeable, and recovery is the side that had to move. On the
disaster path `reproject_blocks_from_engine` (Pass C) drives every block through R9's
live-under-tombstone sweep:

- `NULL` reads as `(sql None, ancestor Some)` — the sweep fires and stamps the **nearest
  tombstoned ancestor's** cohort, the converged-tree answer adopted in #4188/#4204.
- A stamp of this op's timestamp reads as `(sql Some, ancestor Some)`, which the resurrection
  guard leaves alone.

The wider reach therefore *cemented* the wrong cohort past the only healer in the boot path.

## What moved, and what deliberately did not

`materialize_cascade_cohort` now takes a `CascadeReach`. Two arms write **live** rows and take
`Active`: the `delete_block` arm and the move sweep. They had to move together — they are the
two replay orders of the same op pair (`{Move(B → P), Delete(P)}` lands in the delete arm,
`{Delete(P), Move(B → P)}` in the sweep), so a reach split between them is exactly the
replay-order divergence #4187 exists to remove.

Three arms keep `Standard` because their target rows are themselves tombstoned: `restore_block`,
the move un-sweep, and `purge_cascade_step`. The un-sweep/`restore_block` pair is the *other*
axis and stays pinned; its long-standing comment now says so instead of pointing at the sweep
gap that just closed.

The truncation probe mirrors the reach. Under `Active` a tombstoned frontier child is not tree
the walk failed to reach, so the probe adds `c.deleted_at IS NULL` and the documented
false-positive list drops from three shapes to two.

**Era-agnosticism survives** because the walk filter carries no timestamp. #618's TEXT/INTEGER
split is about the *stamp*; `deleted_at IS NULL` behaves identically in both eras, which is why
the reach could be aligned while the hand-rolled era switch stayed (#2043 is still open for the
stamp, and its comment now says the reach is no longer part of the gap).

## A test that was pinning nothing

The move sweep's half of the pair was **uncovered**. The two existing sweep tests use an
all-live subtree, or a tombstoned subject where the sweep never fires at all — so a revert of
just that arm would have survived. That is the half-covered-pair shape, on the arm whose
agreement with the delete arm is the entire point. `recover_move_sweep_stops_at_a_tombstoned_child`
now pins it.

Worth recording because a comment claimed otherwise:
`recover_move_of_an_already_tombstoned_block_keeps_its_original_cohort` does build a live block
under a tombstoned child, but its subject is tombstoned, so the ancestor probe yields no seed
and the sweep never runs. It was never a witness to the sweep's reach.

## One test changed its assertion

`recover_delete_cascade_truncation_is_structural_not_semantic` pinned the delete arm's accepted
false positive: a truncation reported on a rebuild byte-identical to the uncapped one, because
everything past the cap was already tombstoned. Pruning the walk makes the probe **exact** for
that shape, so it now reports nothing, and the test is renamed
`recover_delete_cascade_stops_at_an_already_tombstoned_deep_tail`. The name had to move because
it *was* the assertion. The two row assertions above it (tail keeps its original cohort, the
reachable cohort stamped in full) passed unchanged, so the rebuilt table is identical and only
the report moved. Genuine delete-cascade truncation — a **live** tail past the cap — is still
pinned by `recover_delete_cascade_reports_its_depth_cap_truncation`, untouched.

## Verified

The parity test was written and shown red **before** any production change:

```
kernel=Some(None) recovery=Some(Some(1788489724780))
```

— recovery stamping the row the kernel leaves live, which is #4233 stated as a divergence between the
two interpreters. `restore_ancestor_divergence_is_pinned` passed unchanged with the extra op in
the shared corpus.

Falsified twice, each time against a `cp` backup and restored `cmp`-verified byte-identical.
First, flipping both `Active` sites back to `Standard`: all three new or retargeted tests
reddened. Then, after review round 2 replaced the copied CTE bodies with `concat!()` over the
store's macros, pointing `ACTIVE_WALK` at `descendants_cte_standard!()` instead:
`recover_move_sweep_stops_at_a_tombstoned_child` and
`delete_cascade_reach_past_a_tombstoned_child_agrees_with_kernel` both reddened, which is what
proves the macro actually carries the Active filter.

`cargo nextest run --workspace`: **6346 passed**, 0 failed. After the `concat!()` swap, the
recovery + guard selection: 194 passed, and the seven load-bearing guards run by name: 7 passed.
clippy and fmt clean.

**On the depth-cap guard, precisely.** An earlier draft of this log said
`cohort_cascade_drift_guard` "walks `../src` and saw the new `ACTIVE_WALK` arm". That was true of
the first implementation and is **false of what merged**: after the `concat!()` swap `recovery.rs`
contains zero `JOIN descendants d ON b.parent_id = d.id` occurrences, so the guard's per-file count
for it is 0/0 and the literal `d.depth < 100` is pinned in the store macros instead, by
`macro_variants_pin_canonical_filters`. What running the guard established is narrower and still
worth having: the swap did not drop the workspace below the guard's own `total_arms >= 5` sanity
floor, which is the assertion that would have caught the anchor regex silently disabling itself.

No `sqlx::query!` was touched — every statement here is the runtime `sqlx::query` form, so the
four `.sqlx/` caches did not move.
