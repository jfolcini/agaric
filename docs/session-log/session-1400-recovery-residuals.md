# Session 1400 — a headline fix that was dead code, and a test that passed anyway

#4018 and #4020, the two residual lists from the #4016 review. Eleven items, and the
useful output is the disposition table rather than the diff: **three were correct to
leave alone, three carried a false claim, and one was inert.**

## The inert fix

#4018's headline item is a write-lock storm: when the batch tombstone purge fails, the
#3311 fallback retries one root at a time, each paying a full `busy_timeout` wait — so a
*contention* failure, which belongs to none of the roots, costs one serialised wait per
root.

The inherited work added an `is_write_contention()` classifier and two bail-out branches.
The outer one read:

```rust
Err(e) if false && is_write_contention(&e) => { … }
```

**Dead code.** The fix was inert, and this is the second `if false &&` stub found in this
subsystem in one session (the first was in the #4287 purge repair).

Worse, **the test passed**. With the outer branch dead, control fell into the #3311
fallback and the *inner* branch bailed on the first root — so the run still ended in `Err`
with a contention error, and the inherited assertion
(`!out.contains("root could not be purged")`) was satisfied, because the inner branch
returns *before* that log line ever runs.

The assertion now pins the batch-level line that actually marks fallback entry:

```rust
assert!(!out.contains("falling back to one root at a time"), …)
```

That is the whole lesson: an assertion that is true for two different reasons cannot tell
you which one happened.

### The branch no test could reach

The inner contention branch was unreachable by construction. Getting there needs the writer
to go busy *between two per-root retries*; holding the lock from the start makes the
**batch** fail busy instead, because every pre-flight in `purge_blocks_by_ids_inner` — the
live-id refusal, the depth probe — runs inside the `BEGIN IMMEDIATE`.

Extracting `purge_roots_one_at_a_time` (~25 lines moved, no behaviour change) lets a test
drive the loop directly with the lock held. A branch that cannot be reached from a test is
not covered no matter how it reads.

## Three false claims, deleted

- **`recovery.rs`** claimed "a target block can be peer-authored only on a vault that HAS
  engine snapshots." Reachably false — `apply_cursor_resets_to_zero_when_snapshot_missing`
  and `rewind_boot_then_create_lands_in_projection_with_intact_content` both pin the shape
  where the cursor has advanced and `loro_doc_state` is empty. It also mis-stated
  `reproject_blocks_from_engine`'s early return (missing table, *or* all-NULL/empty blobs —
  not just "empty table").
- **`crud.rs`** said "all THREE purge variants share this guard." Only two do.
  `purge_all_deleted_inner` seeds from the **flat** `SELECT id FROM blocks WHERE deleted_at
  IS NOT NULL`, not a recursive CTE — no depth cap to saturate, and no probe. The comment
  conflated "shares the cascade helper" with "shares the guard."
- **#4018-5's** "leave it and say why" comment carried one false claim in its last
  paragraph, rewritten.

## Scope cut

**#4020-2** asks for "an early bail-out at the top of the function." The inherited diff also
added a per-write `registry.generation()` re-check inside the loop. Deleted: it is scope the
note did not ask for, cannot be pinned by any deterministic test, and guards nothing — every
write there is `UPDATE … WHERE space_id = ?`, which matches zero rows once a RESET has wiped
the table. The enclosing loop's `INSERT OR REPLACE` is the one that could resurrect a blob,
and that is what the entry check covers.

## Correct to leave alone

Three items needed nothing, verified rather than assumed: **#4018-3** (the second seq
allocator) landed in #4370 — `dag.rs:683` now calls `next_seq_for_device`; **#4018-4** (the
unguarded op-log bypass) shipped as `scripts/check-op-log-delete.py` plus two prek hooks;
**#4020-6** was a review caveat with nothing to do.

## Falsification

Six behaviour changes, each reverted and re-run. Two are worth naming:

- **The classifier's poison direction.** Adding `SQLITE_CONSTRAINT` to the contention match
  reddens the new test *and* the pre-existing #3311 test — the half-covered-pair check, since
  a classifier that calls everything contention would otherwise look fine.
- **The heal downgrade, both ways.** Forcing "always warn" reddens the healthy-boot test;
  forcing "never warn" reddens the stale-snapshot and missing-snapshot tests. Dropping just
  the `snapshot_count > 0` conjunct reddens only the missing-snapshot one.

Two arms the inherited test left unpinned (`PoolTimedOut`, and the `_` catch-all) now have
assertions, each proven to redden.

## Verification

`cargo fmt --check`, `cargo check --all-targets` and `cargo clippy --all-targets --workspace`
all clean. 455 recovery/tombstone/attachment/replay/maintenance tests pass; plus 68 in
`agaric-engine` and 193 in `agaric` under narrower filters, because the required filter does
not reach the engine crate's new test.

Against `main`, this is a single pure-addition diff: 1066 insertions, 38 deletions across 7
files in `src-tauri` (1169/38 across 8 once this session log is counted). The `if false &&`
stub described above lived only in the uncommitted working tree this session started from —
`main` carries none of it, and this branch has no earlier commit to diff against — so there
is no prior baseline to subtract and no "production code net shrank" comparison to make here.
`is_write_contention`, both bail-out arms, and every falsification test in this diff are new.
