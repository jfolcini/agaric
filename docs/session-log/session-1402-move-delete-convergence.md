# Session 1402 — what a delete means to a block that moved out

#4204 and #4188. Both are convergence bugs: two peers replaying the same ops in different
orders reached different final states, and in #4204's case the block was *trashed on one
ordering and live on the other*.

## This needed a maintainer ruling, and got one

#4204 carried an explicit hold — "I am not deciding it autonomously… a product call about
what a delete means to the user who issued it." The work stopped at the decision boundary
and asked, rather than deciding by implementing.

**Ruling (2026-08-26): adopt the converged-tree rule.** A block moved out of a deleted
parent onto a live one stays live — a real resurrection, accepted deliberately.

Three reasons, recorded so this is not re-litigated:

1. It is the **only** rule that converges both issues (see below).
2. It makes the op path **agree with the import path**, which already ships this answer.
3. A delete stamps a *cohort*, and cohort membership is positional. Moving a block out of a
   trashed subtree is an explicit act on that block, and it wins over an inherited stamp the
   block never carried intrinsically.

## The rule

> `deleted_at` is a function of the **converged tree**, not of replay order. A cohort **root**
> keeps its own stamp. Every other block's `deleted_at` is the nearest tombstoned ancestor's
> `deleted_at` **in the tree it is in now**, and `NULL` when that whole chain is live.

Order-independent because its two inputs are `parent_id` — converged by the engine's per-key
LWW — and the set of cohort roots with their stamps, where a root's stamp is its
`DeleteBlock` record's immutable `created_at`. Every other `deleted_at` is a pure function of
those two.

Mechanically: before the reparent, `inherited_cohort_before_move` classifies the subject's
tombstone as **inherited** (`b.deleted_at IS NOT NULL AND parent.deleted_at = b.deleted_at`,
the codebase's existing structural cohort test) or **intrinsic**. After the reparent,
`unsweep_inherited_cohort_after_move` clears an inherited cohort unless the new position's
nearest tombstoned ancestor already carries the same stamp, and the existing #4112 sweep
re-derives from the new position.

## #4188 is not separable — measured, not argued

#4188's own comment proposes scoping the fix to fire "only when the new position has a
tombstoned ancestor — re-stamp, never resurrect." That was implemented **literally** and run:

```
#4188: replay order [0, 2, 1] diverges from [0, 1, 2]
```

Order `D(P1), M, D(P2)` still lands on `t1` — the un-sweep declines because P2 is live at that
moment, and `D(P2)`'s cascade then skips the already-stamped row.

So converging #4188 **requires** the transient resurrection. A "never resurrect" fix cannot
converge it. One ruling gates both issues.

## It follows precedent rather than competing with it

`reproject_block_deleted_at_from_engine`'s R9 table (`projection.rs:1477`) is keyed on
`(sql_deleted_at, nearest_tombstoned_ancestor)`:

| | ancestor `None` | ancestor `Some` |
|---|---|---|
| sql `Some` | **restore the cohort** | keep deleted (resurrection guard) |
| sql `None` | nothing | sweep into ancestor's cohort |

The un-sweep's resurrection arm is exactly R9's `(Some, None)` cell. **The import path already
shipped this answer**; the op path disagreed with it. This removes a disagreement rather than
adding a second rule.

## The engine arm was unreachable code

The inherited work mirrored the un-sweep onto the Loro register. That mirror could never run:
`apply_move_block_via_loro` opens with `resolve_block_space`, which filters
`deleted_at IS NULL`, while `inherited_cohort_before_move` requires `deleted_at IS NOT NULL`
on the same row in the same transaction. **Mutually exclusive.**

Measured rather than argued: `#891` fallback-count assertions come back `1` (#4204) and `3`
(#4188), so every tombstoned-subject move routes to `apply_move_block_sql_only`.

Consequence, and it is **not fixed here**: the SQL clear is never mirrored onto the engine
register, so the next snapshot import re-trashes the subtree. The dead code is cut; 25 lines of
doc remain explaining why it must not be re-added and what the durable fix is — a #2868-shaped
post-commit fan-out via `resolve_soft_deleted_block_space`. A **characterisation test**,
`unsweep_does_not_yet_reach_the_engine_register_4204`, measures the re-trash end-to-end, so the
gap is pinned rather than assumed.

## The fix shipped disabled

`inherited_cohort_before_move` carried `return Ok(None); // TEMPORARY #4204 REVERT`, left mid-
falsification. The whole fix was inert.

That is the **third** disabled-fix stub found in this subsystem in one session — the others were
`if false &&` guards in the #4287 purge repair and #4018's contention bail-out. In every case the
surrounding tests passed.

## Falsification

Both convergence tests replay one appended `OpRecord` set through the real
`append_local_op` + `apply_op_tx` + commit pipeline on independent engine-backed worlds, and
assert identical `world_shape` plus pinned non-vacuous values. #4188's `append_delete_at` forces
distinct `t1`/`t2` — without that, every cohort assertion is vacuous.

Removing the materializer un-sweep reddens both orders of #4204 and order `[1,2,0]` of #4188;
removing the recovery un-sweep reddens the positional-inheritance assertions; disabling the
short-circuit reddens both arms (without it, a pre-existing live orphan under the subject is
wrongly adopted).

## Also fixed while here

The new `query_scalar!` had **no `.sqlx` cache entry at all** — CI's `prepare --check` would
have failed. Generated with `just gen-sqlx` (3 added, 0 deleted, drift guard clean). Note for
the next person: bare `cargo sqlx prepare --workspace` deletes 82 entries; use `just gen-sqlx`.

## Verification

`cargo fmt`, `cargo check --all-targets`, `cargo clippy --all-targets --workspace` all clean.
Requested filter 916/916. **Full workspace 6151/6151 passed, 0 failed.**
