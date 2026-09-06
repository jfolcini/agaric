# Session 1554 — the cohort the index never heard about

Closes #4733. `delete_block` soft-deletes a seed and everything under it, but the `DeleteBlock` invalidation only emitted `RemoveFtsBlock` for the seed, so every descendant kept its `fts_blocks` row until boot or a large inbound sync. Search never showed those rows (every read filters `deleted_at IS NULL`), but they inflate the trigram index and skew bm25 statistics over rows nobody can reach.

The arm cannot name the cohort: `invalidations_for_op` is a pure function of the `OpRecord`, and the cascade computes the cohort inside the apply transaction. But the cohort is already in hand at every post-commit fan-out site — `effects.deleted_cohort` on the delete paths, `restore_cohort` plus `restored_chain.chain` on the restore paths — which is where #4285 put the link half of this exact repair. What shipped mirrors it: two infallible post-commit helpers beside `reindex_restored_cohort_links`, `remove_deleted_cohort_fts` (one batched `DELETE … json_each` over the list the cascade consumed, no stripping, no reference-map scan) and `reindex_restored_cohort_fts` (one `reindex_fts_for_ids` pass over cohort ∪ ancestor chain, so a restored nested block's un-deleted parents come back searchable), called at `delete_block_inner`, `delete_blocks_by_ids_inner`, `restore_block_inner`, `restore_blocks_by_ids_inner`, `restore_all_deleted_inner`, `apply_op` and the `BatchApplyOps` arm. The seed is repeated rather than filtered out, as #4285 chose. No new task variant, no ancestor CTE, no `.sqlx` movement: the store side only lifts the chunk loop out of `reindex_fts_references` as `reindex_fts_for_ids` and adds the batched delete, whose SQL text the loop already cached.

The reconciliation oracle drops the `fts_blocks` tombstone tolerance #4735 had to add: a tombstoned block owes no row, and a retained row is reported. `fts_tombstoned_rows_tolerated` became `fts_tombstoned_blocks`, the non-vacuity counter for the removal half. B6's driver mirrors the two new fan-outs the way it already mirrors the three engine ones.

Falsified against copies of each file, restored and `cmp`-verified after every run. Dropping `remove_deleted_cohort_fts` at `delete_block_inner` reddens `delete_block_inner_de_indexes_the_whole_cohort_4733` (the two descendants keep their rows) and, through the shared delete helper, the four command-site restore tests. Dropping `reindex_restored_cohort_fts` at `restore_block_inner` reddens exactly `restore_block_inner_re_indexes_the_whole_cohort_4733` and `restore_block_inner_re_indexes_the_un_deleted_ancestor_chain_4733`. Passing `&[]` for the chain at that same site reddens exactly one test, the nested `restore_block_inner_re_indexes_the_un_deleted_ancestor_chain_4733`, and dropping the ancestor half inside the helper itself reddens the nested restore on every arm — `restore_of_a_nested_block_re_indexes_its_un_deleted_ancestors_4733` and `a_batched_delete_and_restore_move_the_whole_cohort_4733` on the engine side, `restore_blocks_by_ids_inner_re_indexes_the_cohort_and_chain_4733` beside them.

The first commit's `proptest-regressions/materializer_app_tests/apply_reproject_proptest.txt` seed is dropped: it was persisted by a B6 failure against the intermediate task-based shape, where the repair settled on the background queue. The post-commit fan-out runs inside the same call, so the chain the seed pins is no rarer than any other chain containing a delete of a parent — it pins nothing the strategy does not generate freely.

## Review round 1 — the reverse path was a new regression

`agaric-reviewer` blocked, correctly, on a case the shape above never covered.
`apply_reverse_in_tx`'s `RestoreBlock` arm cascades the whole cohort plus the
#1884 ancestor chain, but its callers (`revert_ops_inner`, `undo_page_op_inner`,
`redo_page_op_inner`) only `enqueue_background(op_record)` — which yields
`UpdateFtsBlock` for the SEED — and `RebuildFtsIndex` is a member of neither
`FULL_CACHE_REBUILD_TASKS` nor `CONTENT_RESTORE_REBUILD_TASKS`, so nothing
reached the descendants.

Before this PR that was survivable by accident: the matching delete left every
descendant's row in place, so undoing it found them already indexed. The moment
`remove_deleted_cohort_fts` started working, undo became: create P → C, delete
P, undo, and C is live with no row — unfindable until the next boot rebuild,
which is the one failure the oracle's `FTS_OWNER` text names. Worse, the
tightened `reconcile` now reports it, so the invariant the PR claimed was not
the one production kept.

The arm has both lists in hand, so it hands them back. `ReverseFtsFanout`
carries `deleted` (the `DeleteBlock` arm's cohort) and `restored` (the
`RestoreBlock` arm's cohort followed by the ancestor chain); every caller runs
`fanout.apply(pool)` after `commit_and_dispatch`, and `revert_ops_in_tx` merges
across the batch so N reversed ops pay ONE repair rather than N. Both halves are
covered because redo-of-an-undone-delete goes through the `DeleteBlock` arm and
has to take the cohort back out.

`restore_page_to_op_inner` is the one caller with a rollback branch, and the
fan-out runs only on the committed side — repairing FTS for a cascade that never
landed would be this PR's divergence inverted.

Three non-blocking notes folded in, since a push was going out anyway:

- `delete_blocks_by_ids_inner` called `remove_deleted_cohort_fts` once per root
  inside the fan-out loop, though `union_cohort` a few lines up already names the
  deduped set the SQL cascade consumed. One call over the union.
- `restore_all_deleted_inner` and `restore_blocks_by_ids_inner` did the same with
  `reindex_restored_cohort_fts`, which is worse: `reindex_fts_for_ids` pays a
  `load_ref_maps` — a full scan of every tag and page block — per CALL, so an
  N-root trash restore paid N of them. Both hoisted to one pass over the union.
  The three helpers now take `&[S: AsRef<str>]` so a borrowed union needs no
  second owned list beside the one the SQL consumed.
- The oracle test's comment claimed `FTS_TAGGER` survived because "the cohort
  pass keys on each id's own `deleted_at`" and the walk was rooted at its
  tombstoned parent. `remove_fts_for_blocks` does neither: it is a plain batched
  DELETE over exactly the ids handed to it, and `FTS_TAGGER` survives because it
  is not in the literal on the next line. The assertion is not vacuous — it pins
  that the DELETE does not over-reach — so the comment now says that instead.

`remove_deleted_cohort_fts`'s rustdoc listed the reverse path among the reasons
the seed's `RemoveFtsBlock` task must stay. It no longer belongs there; the
inbound-sync apply path, which runs no fan-out of its own, is what keeps it.

Falsified against a copy: making `ReverseFtsFanout::apply` a no-op reddens
exactly `undoing_a_delete_re_indexes_the_whole_restored_cohort_4733` and
`redoing_a_delete_de_indexes_the_whole_cohort_again_4733`, and nothing else.
Restored and `cmp`-verified.

## Review round 2 — three notes, one of them self-inflicted

Approved, no blocking defect. Three non-blocking notes, all folded in rather than
replied to, because the first is a regression round 1 introduced:

- `ReverseFtsFanout` was inserted between `apply_reverse_in_tx`'s rustdoc and its
  `#[expect]`/`fn`, so ~50 lines of function documentation rendered on the struct
  and the function was left undocumented — including the `op_created_at`
  paragraph that exists to stop a future maintainer re-reading the clock and
  making redo-of-that-undo match zero rows. The struct and impl moved above that
  docblock; a pure move, no text changed.
- The `BatchApplyOps` arm called `reindex_restored_cohort_fts` per record — the
  exact per-call `load_ref_maps` cost this PR hoisted out of the two command
  batch sites. An inbound batch carrying N restore ops paid N full scans of every
  tag and page block. Now one union pass after the loop, matching the others.
- `remove_deleted_cohort_fts`'s rustdoc and the `ReverseFtsFanout` doc both
  narrated review history. Trimmed to the rule and its one reason; this file is
  where the archaeology belongs.

## Review round 3 — the `MoveBlock` tail is a third cascade

Blocking, and the same accident round 1 found on the reverse path, a third
time: this PR made a delete remove rows, and every path that un-deletes without
a `RestoreBlock` op inherited an obligation it never had before.

`unsweep_inherited_cohort_after_move` clears an INHERITED tombstone downward —
exactly the blocks a `DeleteBlock` cascade tombstoned — and its ids come out as
`ApplyEffects::unswept_cohort`, a separate field from `restored_cohort`. The
`OpType::MoveBlock` arm of `invalidations_for_op` enqueues no FTS task at all,
deliberately, because the pre-#4733 rule was "a tombstoned block may keep its
row; search filters `deleted_at` at read time". So neither post-commit site
reached it.

The merge #4204/#4188/#4390 exist for: device A deletes P (child C, grandchild
G) and device B concurrently moves C under a live page. Replaying both, the
un-sweep clears C and G — live, visible in the tree, and with no `fts_blocks`
row until the next boot rebuild. `sweep_move_under_tombstoned_ancestor` is the
mirror: it buries a live subtree, whose rows then survive and which the
oracle's now carve-out-free rule reports.

Both halves come from one signal, so they cost one field. The tail's two
functions were left alone — their return type has nine test call sites, and
widening `unswept_cohort` would change what `dispatch_unswept_cohort` replays
onto the engine and what #4390's skip metric counts, neither of which is this
PR's business. Instead the kernel reads the SUBJECT's own `deleted_at` either
side of the tail: the un-sweep clears a cohort rooted at the subject, the sweep
stamps the subject and its subtree, and #4188's shape does both and settles on
a different ts — each moves that value, and each derives every descendant's
value THROUGH the subject, so an unchanged subject means an unchanged subtree
and the walk is skipped. That is every local move and the overwhelming majority
of remote ones.

The result is `ApplyEffects::move_fts_cohort`, consumed at `apply_op`, the
`BatchApplyOps` arm, and B6's driver. ONE list for both directions, because
`reindex_fts_for_ids` re-derives membership per id rather than assuming one: a
live id gains a fresh row, a tombstoned one loses the row it had.

B6's driver mirroring it is not optional. The generator emits `MoveBlock` after
`DeleteBlock`, so it reaches this shape; a driver missing the call would redden
`reconciliation_failure` on those chains — a green run today would have been a
generator that had not hit it yet, not a proof.

The remaining non-blocking note is taken too: `reindex_restored_cohort_fts` now
takes ONE slice. It concatenated its two on the first line, and five of its
eight call sites passed `&[]` for the second; the two-slice shape only mirrored
`reindex_restored_cohort_links`, which needs the split because it dispatches the
groups differently.

Falsified against a copy: dropping the subject-`deleted_at` comparison (so
`move_fts_cohort` stays empty) reddens exactly
`an_un_sweeping_move_re_indexes_the_subtree_it_revived_4733` and
`a_sweeping_move_de_indexes_the_subtree_it_buried_4733`, and nothing else.
Restored and `cmp`-verified.
