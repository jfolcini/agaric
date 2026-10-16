# Session 2178 — The twelve Rust mutation survivors

This morning's weekly run on main reopened #4651 (`loro/engine/mod.rs`, 1),
#4652 (`loro/engine/snapshot.rs`, 5) and #4656 (`reverse/batch.rs`, 6). All
twelve had been accepted before; the run dropped those acceptances because
the lines moved (#4690's re-anchored list). Each verdict was re-derived from
the code, not carried forward.

Six disappear with the code they mutated. `tree_depth_of` and
`has_ancestor_in` (`snapshot.rs`) capped their ancestor walks at a million
hops: nesting is capped at `MAX_BLOCK_DEPTH` on create and move, and Loro's
movable tree has no cycles, so the cap could only fire on a chain that
cannot exist, and would then return a wrong answer rather than a safe one.
`ancestors_outside` beside them already walks uncapped. The caps are gone;
every remaining mutant in both functions is caught or unviable.
`fetch_live_attachment_state_batch` divided its chunk size by
`LIVE_ATTACHMENT_BINDS_PER_OP = 1`; the division and constant are gone.

Six are equivalent and stay `missed`, recorded in #4690's accepted block:
the five `/` → `%` chunk-size mutants in `reverse/batch.rs` yield a smaller
positive chunk, and each op's subquery is independent, so only the number
of statements changes; `reject_replicated_targets`'s `LIMIT 1` without
`ORDER BY` leaves which replicated op it names unspecified either way.
`init_sibling_ordering` → `()` is inert on the pinned loro 1.13.6:
`TreeState::new` already sets `GenerateFractionalIndex { jitter: 0 }`, which
the call only re-sets. Deleting it is open (the comment at `staging.rs`
that calls `fork` load-bearing for the index would go stale with it).

cargo-mutants 27.1.0 with `--workspace` in copy mode confirmed every claim.
The builds ran in a private target dir: the shared one held another
worktree's `agaric-engine` (see session 2180's lesson on shared targets).
