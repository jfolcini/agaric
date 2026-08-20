# Session 1356 — adversarial review of the replay-path tombstone guards (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only |
| **Items closed** | `#4112`, `#4121` |
| **Items modified** | — |
| **Items filed** | `#4187`, `#4188` |
| **Tests added** | +0 (frontend) / +10 (backend — 5 in the reviewed diff, 5 added by this review) |
| **Files touched** | 6 |

**Summary:** Reviewed an uncommitted diff against the apply/replay kernel that nobody in
this session wrote. Both fixes hold: the #4112 sweep converges every ordering tested, and
#4121's macro-seed filter is sound at both of its call-sites. The review's own contribution
is five convergence tests over op sets and orders the diff never exercised — three-op
permutations, restore-after-sweep, idempotence, nested tombstones at different timestamps,
and the tag cache — plus every claim in the diff's prose checked against a mutation rather
than read.

## What the diff claimed, and how each claim was tested

The diff answers #4112's open design question — *is a live block under a tombstoned parent
legal?* — with **no**, and enforces it by sweeping rather than by mirroring the local
command path's rejection. The whole deliverable is convergence, so the review method was:
re-derive the behaviour table independently, extend it to op sets the diff did not cover,
and for each new and existing test, name the production change that should redden it and
make that change.

### The behaviour table, re-derived

For `{Delete(P), Move(B → P)}` the three candidate behaviours resolve as the diff says.
Rejection leaves `B` under its old parent when the delete replays first and trashed under
`P` when the move does; the pre-#4112 unguarded apply leaves `B` live under a tombstone one
way and trashed the other; only the sweep gives `B` under `P`, trashed at `P`'s
`deleted_at`, in both orders. That much the diff already pinned.

Extending it is where the design earns its keep:

- **Three concurrent ops, all six orders.** `{Delete(P2), Move(C1A → P2),
  Move(C1B → C1A)}` — so a device can have to sweep a block whose tombstoned ancestor was
  itself produced by an *earlier sweep* rather than by a delete cascade. All six converge.
- **Move-then-restore.** `{Delete(P2), Move(C1A → P2), Restore(P2)}` in both delete/move
  orders. This is the case that makes "the ancestor's `deleted_at`, not `now`" load-bearing:
  `RestoreBlock` descends only into a child whose `deleted_at` equals the seed's
  `deleted_at_ref`, so a sweep stamping `now` would put the moved subtree in a cohort of
  its own and leave it trashed under a restored parent.
- **Nested tombstones at different timestamps.** Trash `C1A`'s subtree, then trash `P1`;
  `P1`'s cascade skips already-stamped rows, so the two cohorts keep different stamps. A
  block moved under `C1A` must take the **nearest** stamp — the topmost one would leave it
  trashed under a restored parent for the same reason.
- **Idempotence.** The same `MoveBlock` record replayed twice. The second pass takes the
  healthy branch (the subject is now a tombstone) and must not re-stamp at a fresh
  timestamp, which would split the block out of the cohort the first pass put it in.
- **The tag cache.** Both orders must agree *and* agree with `rebuild_all`, the arbiter the
  whole #3919/#3926/#3944/#4121 family is measured against.

The one ordering that does **not** converge turned out to be strictly pre-existing and is
now #4188 — see below.

### Every test was reddened on purpose

Six mutations, each applied to production code, run, and reverted:

| Mutation | Result |
|---|---|
| Remove the sweep call from both arms | 6 of 7 #4112 tests red |
| Stamp `now` instead of the nearest ancestor's cohort | all 7 red |
| Mirror the local path's tombstoned-**subject** rejection onto the replay arm | `move_of_a_tombstoned_block_is_applied_not_dropped_4112` red |
| Sweep with `recompute_subtree_inheritance` instead of `remove_subtree_inherited` | the new tag test red |
| Revert `tag_inh_descendants_active!`'s seed filter | both #4121 guards red |
| Invert that filter to `IS NOT NULL` | the live-subject non-regression test red |

Two of these are worth calling out.

The **tombstoned-subject** mutation is the one that validates the diff's most contestable
choice: it deliberately does *not* mirror the half of the local guard that refuses to move
a trashed block. Adding that guard makes `{Delete(B), Move(B → Q)}` resolve to "`B` under
its old parent" one way and "`B` under `Q`" the other. The argument in the docstring is
correct, and it is now an argument with a failing test behind it rather than a paragraph.

The **tag-helper** mutation exposed exactly the failure its docstring predicted, which is
the strongest evidence in the session that the author understood the code rather than
pattern-matched it. Substituting `recompute_subtree_inheritance` for
`remove_subtree_inherited` leaves a stale `(G1A, TAG, P1)` row on the delete-first device —
because `subtree_active`'s walk can no longer see past the root the sweep just tombstoned —
while the move-first device wipes it via the delete's own subtree sweep. Two devices, two
tag caches, and both disagree with `rebuild_all`. The test that catches it did not exist
before this review.

## The engine mirror is inside the rollback checkpoint

The claim that most needed independent verification, because an engine write that survives a
SQL rollback is precisely the split-brain the code exists to prevent.

It holds, and the mechanism is #2604's. `for_space_recording` records a rollback checkpoint
via `RevertLog::record_first_touch`, which captures the pre-op frontier on the **first**
touch of a space in a tx and deliberately refuses to overwrite it on later touches — "the
rewind discards ALL ops since the first". `apply_move_block_via_loro` takes its first
`for_space_recording` guard for the move itself; the sweep's mirror takes a second one for
the *same* `space_id`, so it is a later touch, records nothing, and is covered by the
checkpoint the move already installed. On abort, `revert_entries` rewinds the exact
`Arc<Mutex<LoroEngine>>` captured at first touch — both mutations, together.

Two follow-on checks: the cohort cannot span spaces (the engine arm requires the target
parent to live in the same per-space tree, and a cross-space move takes the fallback), and
the mirror holds no guard across an `.await`.

The `sql_only` arm sweeps SQL without an engine mirror. In its primary case there is no
engine to mirror to. In the `EngineMissingTarget` sub-case the block *can* be in an engine
that now disagrees — but that cannot resurrect the row, because
`reproject_block_deleted_at_from_engine`'s `(Some(_), Some(_))` arm is literally
"SQL-deleted under a tombstoned ancestor → no-op". The diff's comment claimed the two arms'
tails were "identical", which is not true and hid this; corrected in place.

## #4121 — the call-site audit

The soundness argument is a claim about *every* expansion of a macro, and one
`DELETE`-scoping call-site would turn the filter into silent data loss. Enumerated:

- `propagate_tag_to_descendants` — one `INSERT OR IGNORE … SELECT FROM descendants`.
- `remove_inherited_tag` step 3 — one `INSERT OR IGNORE … FROM descendants d,
  nearest_ancestor na`.

Both INSERT-only; no third expansion exists. Step 1's `DELETE` is keyed on
`inherited_from = ?1` and never consulted the CTE, and step 2 hand-rolls its own copy of the
walk. So the #3944 trap — filtering a seed that also scopes a repair pass's `DELETE` — does
not apply here, and the contrast with `tag_inh_subtree_active!` (which scopes two `DELETE`s
and must keep admitting a tombstoned root) is real.

The "step 3 was already a no-op for a tombstoned subject" claim was checked rather than
taken: step 3 cross-joins `descendants` with `nearest_ancestor`, which derives from
`tag_inh_ancestors_walk!(1)`, whose seed has required a live `?1` since #3944 — so the join
produces zero rows either way. It is a genuine non-change.

One detail in the implementation deserves a note, because it is the kind of thing that
passes a shape guard while being wrong: the filter is written as
`JOIN blocks r ON r.id = ?1 AND r.deleted_at IS NULL`, and `descendants_active`'s seed
*also* carries a `?1` predicate that is not the subject check (`b.parent_id = ?1` constrains
the emitted child). The diff's extension of `root_seeded_walks_filter_the_subject` spells
the expected conjunction per macro, on the aliased column, rather than sharing one
alias-blind needle — which is correct, and is what stops the guard passing with #4121 fully
reopened.

## Findings filed rather than fixed

**#4187 — `recovery.rs`'s `move_block` arm is not safe to leave unswept.** The brief asked
whether the deferral was genuinely safe, given it is a DB-corruption recovery replay. It is
not. Recovery replays the whole `op_log` in `created_at` order; its `delete_block` arm
cascades a soft-delete, and its `move_block` arm is a bare `UPDATE blocks SET parent_id`
with no `deleted_at` filter. For the ordinary pair `{Delete(P), Move(B → P)}` with the
delete earlier in the log, recovery reparents a live `B` under a tombstone and produces the
exact invisible orphan #4112 closes on the materializer arms. Nothing reliably heals it:
R9's sweep only runs per-block on a sync import's changed set. Filed rather than fixed
because recovery cannot reuse `project_delete_block_to_sql` (the era-switched TEXT/INTEGER
`deleted_at` stamp, #2043), so the repair has to be hand-rolled and era-aware — a change
that wants its own test matrix, not a rider on this diff.

**#4188 — a move racing deletes of *both* its endpoints.** Re-deriving the table over
larger op sets found one non-convergent ordering:
`{Delete(P1), Delete(P2), Move(C1A: P1 → P2)}` resolves `C1A.deleted_at` to `t1` or `t2`
depending on which delete's cascade catches it. Both devices agree on `parent_id` and both
have the block trashed, so it is invisible in the tree either way — but they put it in
different restore cohorts. This predates #4112 and neither divergent order involves the
sweep at all (in one the subject is already a tombstone, in the other no tombstone exists
yet); the sweep narrows the answer set from three to two rather than closing it. The
underlying question — which cohort owns a block whose old and new parents are deleted
concurrently — is a semantics decision about the `DeleteBlock` cascade's
skip-an-already-stamped-row rule, not about `MoveBlock`.

## Findings fixed in the diff

Two prose claims that were load-bearing and wrong:

- `apply_move_block_sql_only`'s "Identical to the engine arm's tail so the two arms cannot
  drift" — the engine arm additionally mirrors the cohort onto the per-space engine. Replaced
  with the actual difference and the argument for why the missing mirror cannot resurrect a
  row.
- `sweep_move_under_tombstoned_ancestor`'s "the overwhelmingly common case, costing one PK
  lookup" — the healthy path also pays a depth-bounded `parent_id` climb, on every move
  including a same-parent reorder. The climb is what *decides* "healthy" so it cannot be
  skipped; documented, along with the deliberate absence of a reorder early-out (the helper
  doubles as a repair pass for subtrees that were already orphaned).

A pointer to #4188 was added to the "what it deliberately does NOT do" section, so the known
residue sits where the decision lives.

## Postscript — a pre-push red that was the build, not the code

After the branch was committed (`1b439f17f`) and `origin/main` merged in (`c8ec6a88b`), the
pre-push gate failed at Phase D with **6 failed** tests, all of them from this change. The
natural reading — several PRs landed on `main` overnight, so this is the stale-base hazard —
turned out to be wrong, and the way it was ruled out is the part worth keeping.

**`main` brought in no Rust at all.** The four commits merged were three CI-script changes,
one frontend change, and three session logs: `.github/workflows/`, `scripts/`,
`src/components/block-tree/`, `CONTRIBUTING.md`. No `.rs`, no `.config/nextest.toml`, no
`.sqlx`. There was no interaction available to have.

**The failure did not reproduce.** Running Phase D's exact command — recovered from
`scripts/test-related-rust.sh --range … --dry` rather than guessed:

```
cargo nextest run --workspace --no-tests=pass   -E "test(~materializer::handlers::move_convergence_tests) + package(agaric-engine) + package(agaric-store)"
```

green at 4 threads, green at 16, green six times in a row, and green after
`cargo clean -p agaric-engine -p agaric-store -p agaric` forced all three changed crates to
rebuild from scratch. The `move_convergence_tests` module was looped 40 times (600 test
processes) with no failure.

**The failure count was the fingerprint.** Six is not an arbitrary number here. Of the eight
`4112` tests, exactly two are insensitive to whether the sweep runs:
`move_of_a_tombstoned_block_is_applied_not_dropped_4112` (its subject is the half the sweep
deliberately leaves alone) and `sweep_converges_the_inherited_tag_cache_with_the_arbiter_4112`
(with no sweep at all, both replay orders lose the moved subtree's inherited rows anyway —
one via `recompute_subtree_inheritance`, the other via the delete's own subtree wipe — so
they still agree, and still agree with `rebuild_all`). That leaves **exactly six** that
depend on the sweep.

So the prediction was: the gate ran a binary in which the sweep had no effect. Tested by
disabling the sweep on the current tree and re-running the gate command. The result matched
on every axis available: 6 failed, the same six test names, and the three quoted assertion
strings **verbatim**, down to
`the sweep must inherit the NEAREST tombstoned ancestor's cohort (1600000000000), not the
outer P1 cohort (1700000000000) and not `now`` and
`precondition: the first replay swept C1A into P2's cohort`. The observed left-hand value
was `(Some("…MVC1AA"), None)` — the block never got stamped, i.e. the sweep never ran.

**The test count was the second, independent signature.** The gate reported *1769* tests
run; the same filter on the same tree selects **1771**. A binary that exposes two fewer
tests than its own source defines is a stale binary — nextest can only run what was linked.
Two tests missing and a whole helper's behaviour missing are the same fact.

The cause is therefore a **partially-rebuilt `agaric-engine`**: the test source (in the
`agaric` crate) recompiled while the engine crate was linked from an artifact predating the
sweep. This machine OOM-killed a build during the session, which is exactly how that state
is produced, and the repo's own notes already record the failure mode ("nextest substring
filters can silently skip a binary whose compile was interrupted"; "OOM from lingering
rustc/rust-analyzer kills the gate").

**No production or test code was changed in response to this red.** The right response to a
gate failure whose *shape* says "the fix isn't in the binary" is `cargo clean -p <crate>` and
a re-run, not an edit. Relaxing any of these six assertions would have deleted the
convergence property the change exists to establish, and the diff would have shipped looking
green while proving nothing.

**Lesson.** When a gate reddens on tests you just wrote, count the failures against the
subset that *can* fail for the reason proposed, and check the reported test count against the
source. Both are cheap, and both distinguish "the code is wrong" from "the binary is old"
before any code is touched. Simulating the suspected defect and diffing the failure text
against the report turns that from a hunch into a proof.

**Files touched (this session):**
- `src-tauri/agaric-engine/src/apply/sql_only.rs` (+147 / -1)
- `src-tauri/agaric-engine/src/apply/loro_apply.rs` (+51 / -1)
- `src-tauri/agaric-store/src/tag_inheritance_macros.rs` (+78 / -16)
- `src-tauri/agaric-store/src/tag_inheritance/incremental.rs` (+33 / -0)
- `src-tauri/agaric-store/src/tag_inheritance/tests.rs` (+122 / -0)
- `src-tauri/src/materializer/handlers/move_convergence_tests.rs` (+798 / -1)

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — run in package groups because the
  single invocation exceeds the 10-minute tool ceiling. Pre-merge: 5931 run, 5931 passed.
  Re-run in full after the `origin/main` merge and after a package-scoped
  `cargo clean` of all three changed crates: `agaric` 3581/3581,
  `agaric-engine` + `agaric-store` 1756/1756 (inside the Phase D filter below),
  `agaric-core` + `agaric-observability` + `agaric-diagnostics` + `agaric-sync` 592/592.
  One flake, `sync_daemon::tests::daemon_branch_b_dispatches_all_peers_in_round_l61`, green
  on retry and unrelated to this diff. (The bare form without `--workspace` is
  package-scoped to `agaric` only — #3212.)
- Pre-push Phase D, the gate's own command
  (`scripts/test-related-rust.sh --range origin/main...HEAD`) — 1771 tests run, 1771 passed,
  six consecutive times, and once more after a from-scratch rebuild of the changed crates.
  See the postscript for why an earlier run of this same command reported six failures.
- `cargo fmt --check` — clean (one wrapping fix applied to a new test helper first).
- `cargo check --all-targets` — clean, no warnings.
- `cargo clippy --workspace --all-targets` — exit 0, no warnings.
- `cargo sqlx prepare --check` — exit 0. The one new macro query
  (`SELECT deleted_at FROM blocks WHERE id = ?`) reuses the existing cached entry
  `query-b019321656d1789266fbc0583de37cdfcd7f7be8664912cf2cf9f030069dace6.json`; `.sqlx`
  is unmodified and needs no regeneration. Verified by running the check, not by trusting
  the claim.
- `scripts/check-dynamic-sql.py` on all six touched files — exit 0. The new query is the
  compile-checked macro form, so no runtime site was added and no baseline moves.

**Lessons learned (for future sessions):** a convergence test that ends with a *restore*
can wash out the divergence it was written to catch. The first version of
`swept_subtree_restores_with_the_ancestor_cohort_4112` passed with the sweep removed
entirely — both devices end fully live, because restoring the whole cohort erases the
difference between "was swept" and "was never trashed". It only became non-vacuous once it
asserted the intermediate state as well. The general rule: when a test's final operation is
idempotent-ish or absorbing, assert *before* it too, and prove the whole thing red by
deleting the production change rather than by reasoning about it.

**Commit plan:** not committed — review deliverable only; the branch is left uncommitted for
the caller.
