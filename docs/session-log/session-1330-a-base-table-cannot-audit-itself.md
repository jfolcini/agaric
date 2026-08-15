# Session 1330

## A base table cannot audit itself

#3903 said the pushed-down cross-space filter drops same-space links whose target `space_id` is
not yet stamped. The premise did not survive contact with the code — in a specific and useful way.

The production fix **already shipped** in #3894: the `COALESCE(tgt.space_id, tp.space_id)`
owning-page fallback is on `main` in both call sites, soft-delete guards intact. The issue was
written retrospectively and never closed.

What was missing was the other half of a pair. The two `INSERT … SELECT` statements are textual
twins, but only the single-pool arm had a regression test; the split arm had only a cross-space
exclusion test that never exercises the fallback. And the split arm is the **worse** half to leave
uncovered, because `dispatch_split_or_single` picks `_split` whenever a read pool is configured —
which production always does. So the untested arm was not *a* production path, it was *the*
production path.

Reverting only the split arm's `COALESCE` makes the new test fail while the pre-existing single-pool
test **passes**. That is the cleanest possible demonstration that the covered arm could never have
caught it.

### Why the framing that settled four other issues does not apply here

Several sibling issues this session were decided by one question: *which behaviour does the full
rebuild define, and does the incremental path claim to match it?* It settled #3919 one way and
#3926 the other.

It does not apply to `block_links`, and the reason is worth keeping:

- There is **no vault-wide `rebuild_block_links`**. `truncate_block_links` has one caller, the
  snapshot-restore wipe. Nothing re-derives the table from content except the per-block reindex.
- `rebuild_page_link_cache_impl` reads `FROM block_links bl` — it rolls **up from** the table rather
  than re-deriving it, so a dropped link is missing from the rebuild too.
- The reconciliation oracle's own header lists `block_links` in the **Base tables** column, and
  `rebuild_page_link_cache_from_base` is documented as recomputing "from `blocks` + `block_links`
  alone."

So the oracle treats `block_links` as ground truth. Expected and actual are derived from the same
wrong row, and the divergence is not unlikely to be generated — it is **arithmetically impossible for
the oracle to express**. Every oracle run stayed green through #3903's entire lifetime.

`block_links` appears in neither the oracle's covered list nor its explicit not-covered list. It fell
in a gap rather than having been considered. Filed as #3955, in the shape of #3654, which closed the
same class for `blocks.page_id` by auditing the column against an independent structural walk instead
of against a derivation that already trusts it.

### The measurement, and the number that was overstated

#3891 claimed two unindexed `block_links` scans on every create and edit. The repo's standard is that
reasoned-about performance is not measured performance, so it was measured: 102,000 blocks, 196,000
`block_links` rows, release build, real migrations, real function.

`EXPLAIN QUERY PLAN` gives `SCAN bl` — the predicate is not sargable, as claimed. The gate's own probe
plans as `SEARCH page_link_cache USING COVERING INDEX … (source_page_id=?)`.

The saving is real: **~6.6 ms, ~30%** of the call. The builder had written "~9 ms, ~44%", taking the
*fastest* of four ungated runs as their mean. Corrected to quote all eight runs and both means. A
number that flatters the change is worse than no number, because it is the one a future reader
inherits.

Severity is higher than the issue assumed, and that half held up: this runs inside
`begin_immediate_logged`, which takes the RESERVED lock at `BEGIN`. It is **held write-lock time
contending with foreground writes**, not background CPU. And the `touched_targets.is_empty()` early
return does not help — the scan has already run by the time the result is known to be empty.

### "Vacuous by construction" was the claim, and a fifteen-line probe refuted it

The gate skips a stale key with no cached row. The builder deliberately added no test for the skip
branch, arguing it has no observable behavioural difference by construction — so such a test would be
vacuous.

It has one. Construct `K`, a top-level content block whose own roll-up key is `K`, linking to `T`;
`B` is `K`'s child but stamped to page `P`, so `B`'s stale keys are `[K, B]`; the cache starts empty.

```
gated:   [(P,T,1)]              — diverges from the full rebuild
ungated: [(K,T,1), (P,T,1)]     — converges
```

So the comment's "provably a no-op on the cache" was false, and self-contradictory besides — the very
next clause admitted the UPSERT "could only ADD rows."

The gate is still sound, for the builder's *second* reason rather than its first: those rows are owed
by `K`'s own ungated current-key reindex or by the full rebuild, never by `B`. Reaching that state at
all requires `K`'s reindex to have never run or to have failed — the cache was already divergent
before the call. The gate forgoes a chance heal of a pre-existing divergence; it never drops a repair
the reindexed block itself caused. And unlike #3903, that direction **is** oracle-visible.

The general lesson is sharper than the specific one. When the justification for not testing a branch
*is* a soundness claim, the test is what checks the claim — and here refuting it took fifteen lines.
The gate is now pinned from both sides: removing it reddens the new test, making the skip
unconditional reddens the three #3842 tests.
