# Session 1594 — stop asserting the machine was fast (#4813)

## The flake

`a_user_delete_stays_positionally_undoable_after_the_sweep_4741` failed
intermittently in its FIXTURE, not in anything it tests:

```rust
let gaps_ok = rows.windows(2).all(|w| w[1].3 - w[0].3 <= 10);
```

Consecutive `append_local_op` calls had to land within 10 ms of each other —
true on an idle machine, false under load. nextest retried and the run was
reported green with `1 flaky`, so it cost a lane without ever naming a cause a
reader could connect to their change.

## Why the guard could not simply be deleted

The issue suggests seeding the sweep ops at explicit timestamps. That does not
apply here: those three ops are written by production's
`sweep_leaked_empty_blocks`, which reads the clock itself — the fixture never
touches them.

And the guard is load-bearing. The test asserts `group == 1` while the sweep's
housekeeping rows sit INSIDE the grouping window; the point is that
`find_undo_group_inner` excludes them on `origin`, not on time. If those rows
fell outside the window, `group == 1` would hold because of a window gap and the
origin filter would go completely untested — the assertion would be true for the
wrong reason. Removing the proximity check would have hidden that.

## What changed instead

The window the #4741 tests drive is now a named constant at **60 s** rather than
10 ms, and the fixture's wall-clock guard is replaced by a precondition asserted
against that window:

```rust
assert!(spread < GROUP_WINDOW_MS_4741, …)
```

Both halves improve:

- proximity is now guaranteed rather than hoped for — real elapsed time between
  the sweep and the user's delete is milliseconds even on a loaded runner, so
  nothing about the host can push it past 60 s;
- the assertion is **strictly sharper** than at 10 ms, because a wider window
  gives the housekeeping rows *more* opportunity to extend the group. Passing
  now says more about the origin filter than it did before.

The seeded create/edit ops sit at `FIXED_TS` (2025-01-01), far outside any
window this size, so widening cannot accidentally pull them in.

## Falsification

Against a copy, restored and `cmp`-verified. Both red:

- set the window to 0 → the new precondition fires, so it is load-bearing;
- neutralise the `origin = 'user' OR origin LIKE 'agent:%'` predicate in the
  grouping query → the test fails, so the widened window still catches the real
  defect. That second one is the evidence for "sharper, not looser".

All 7 `_4741` tests pass.
