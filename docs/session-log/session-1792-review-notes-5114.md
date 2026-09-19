# Session 1792 — review notes from #5114

The three non-blocking notes `agaric-reviewer` left on #5114, batched here rather
than pushed onto that branch once it was approved and green. Two are deletions
and one is a rename; all three are about claims the code made and could not keep.

`reject_replicated_targets_chunks_a_max_size_revert_4656` opened with an
`Ok`-assertion on 1000 clean refs before appending the replicated one. The first
read is that this is the accept-arm of a symmetric pair, guarding against the
guard over-rejecting at maximum batch size. It is not: that arm is already pinned
by `..._refuses_a_replicated_revert_target_2549` at `reverse_tests.rs:3964`, and
a guard that rejected everything reddens there first. On the mutant this test
exists for, the 1001-ref call covers it alone — at a chunk width of 1998 the call
raises `Expression tree is too large` rather than the rejection, so `expect_err`
is satisfied by the wrong error and the `contains("rrt-tail")` assertion is what
fails. Verified by applying `MAX_SQL_PARAMS / 2` → `* 2` to a copy with the
`Ok`-assertion already removed: red at `reverse_tests.rs:4063`, the `contains`
line. Copy restored, `cmp` clean. The doc now states that one call covers both
halves, so the next reader does not re-add the first.

`reject_replicated_targets`' doc explained the `MAX_SQL_PARAMS / 2` chunk by
`SQLITE_MAX_EXPR_DEPTH` biting "long before the bind cap does". True only against
SQLite's real 32766. Against `MAX_SQL_PARAMS`, which is the number the width
actually divides, a 499-ref chunk binds 998 of 999 — the opposite of headroom.
That matters more than a usual wording nit because the comment seven lines up in
`batch.rs` exists to say the crate constant is load-bearing for a reason its own
doc-comment does not state; a sentence implying slack in the same file undercuts
it. It now names both numbers and says neither has slack to spare.

`compute_reverse_batch_prev_edit_group_stays_aligned_across_chunks_4656` is
`..._resolves_its_own_prev_edit_pointer_4656`. Unlike the five `fetch_prior_*`
helpers, `fetch_prev_edit_rows_batch` stores the global `pos` in `wanted` before
chunking, so it has no per-chunk base and no alignment to lose — the old name
claimed a property the test cannot check. Session 1791's own reviewer had already
hit this from the other side: it could not falsify that test the way it falsified
the other five, because there is no `base` to zero, and had to inject a different
mutation. What the test does earn is the pointer-vs-timestamp skew, which the
rewritten doc now says instead.

## Verified

- `cargo nextest run --workspace -E 'test(reject_replicated_targets) +
  test(prev_edit_group)'`: 3 passed, 6365 skipped.
- The deletion is the one change here that could silently remove coverage, so it
  is the one falsified: the mutation above reddens the trimmed test. The rename
  and the two doc edits change no executable line.

## Not done

Nothing from #5114's review is left. The 48 jex-import survivors and the 14
accepted-equivalent rust entries recorded on #4690/#4691 are triage state, not
review notes, and stay as they are.
