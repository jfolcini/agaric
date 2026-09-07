# Session 1580 — differential-fuzz the mock against the real backend (#4669)

Closes #4669. The committed `conformance/fixtures/*.json` corpus is a good
*specification* and a poor *regression net*: every divergence it has caught was
caught when someone authored a new fixture, never by the existing ~44 sequences
turning red on an unrelated change. This lane generates the sequences instead —
`op_chain_strategy` (the materializer proptests' generator) → the conformance
fixture vocabulary → the real backend AND the TS mock → compare snapshots, with
proptest shrinking any mismatch to a minimal chain written out as a
ready-to-commit fixture.

The mock is TypeScript, so the comparison runs against a long-lived `node`
process reading newline-delimited JSON: one esbuild bundle and one process
start, then one line per candidate chain, which is what makes it affordable
inside a shrink loop. The bridge calls the SAME `replayFixture` that
`conformance.test.ts` runs over the committed corpus under vitest, so the two
module pipelines stay cross-checked and only the driver is new.

## It found two real mock bugs on its first run

Both are the same root cause — **the mock treated a soft-deleted block as absent
from its sibling group; the backend keeps it there** — and neither was reachable
from the committed corpus, because no fixture creates a sibling after deleting
one.

`reproject_dense_positions` states the rule in its own test: it "assigns dense
1-based ranks for the whole ordered sibling group ... including a soft-deleted
tombstone that keeps its slot" (#419). The mock disagreed twice:

1. **`renumberSiblings` filtered tombstones out**, so they were never renumbered.
   `create → delete → create` left the tombstone at position 1 and gave the new
   block 1 as well — DUPLICATE positions, not merely a drift.
2. **`insertAtSlotAndRenumber` counted only live children** when resolving the
   requested slot. `create(index 0) → delete → create(index 1)` put the new block
   at position 1 in the mock (slot 1 clamped to 0, the tombstone being invisible)
   and at position 2 in the backend (the tombstone still occupying slot 0).

Both are fixed here. The full mock suite — including the whole conformance
corpus — stays green at 799 tests, which is the evidence that these were gaps
rather than deliberate divergences: nothing that was pinned changed.

## What the lane's own numbers are, measured

`DEFAULT_CASES` was 64. At 64 the lane reached only seven of the ten commands
the renderer can emit, so it was comparing less than it claimed. At 256 all ten
appear:

```
create_block 287  edit_block 93  set_property 78  move_block 70
delete_block 44   add_tag 40     remove_tag 35
restore_block 7   delete_property 4  purge_block 4
```

`EXPECTED_COMMANDS` — the floor that stops the lane silently narrowing — is the
seven robust ones. The tail is reported, not asserted: the seed is random per
run, so at ~4 expected hits a run that draws zero is a couple of percent, and a
weekly lane that reddens on its own RNG teaches people to re-run it without
reading it. Every run prints the full tally, so a narrowing is visible whether or
not it crosses the floor.

At 256 cases the run is ~48s standalone and 58.9s under nextest. The default
window is `30s × 2`, so it needs the `slow-timeout` override added beside the
five tests already there — measured, and it TMT'd at 60.010s without it.

## No workflow wiring needed, and why that is not an accident

`scheduled-deep-checks.yml`'s `bench-slo` job already runs
`cargo nextest run --workspace --run-ignored=only`, and it installs Node 24 and
runs `npm ci`, so the bridge has what it needs. That lane's comment carries a
standing rule — every `#[ignore]`d test in the workspace is expected to PASS
there, and one that cannot needs an `-E` exclusion in the same commit. This one
passes, so it takes no exclusion; the comment's list of what kinds of test live
there is updated to say a fuzz lane is now among them.

## Three defects in the branch as found

Worth recording because all three were invisible to a green-looking run:

1. `apply_op` had gained a fourth `created_ids` parameter with two call sites
   left behind (`conformance.rs:1616` / `:1639`). Both name SEED labels rather
   than `C<n>` back-references, so `&[]` is correct there.
2. **`mod conformance_fuzz;` was never added to `command_integration/main.rs`** —
   the file had never compiled at all. `-E 'test(conformance_fuzz)'` ran 0 tests
   and exited 0, which reads exactly like a pass.
3. `TestRunner::run` takes an `Fn`, and shrinking re-enters the closure, so the
   tally and the child process both had to move behind `RefCell`.

Counter-examples are written to `CARGO_TARGET_TMPDIR`, not `<repo>/target`: only
`src-tauri/target` is gitignored, so the latter left the artefact as untracked
noise at the repo root, one `git add -A` from being committed. Cargo hands
integration tests that directory for exactly this.

## Review round 1 — the same bug in three more places

The reviewer found that `revert.ts` carries its own copies of both position
helpers — a circular import forced the duplication — and both still filtered
tombstones out. Their doc comments claimed to mirror the originals, which after
the first fix was false, and the traced sequence is reachable: delete A
(tombstone keeps slot 1), move B away, revert the move, and B is renumbered to 1
on top of A. The fuzz lane can never catch it, because its renderer emits no
undo command.

Chasing that surfaced a **third** copy. `move_block` records `old_position` as
the block's rank among its siblings, and that ranking was also live-only — so
with a tombstone holding slot 1, a block at slot 2 recorded `old_position: 1`
and the revert re-inserted it *before* the tombstone. It is now ranked over the
whole group, like the renumbering it feeds.

All three take the same one-line change, and the shape is now consistent
everywhere: **a soft-deleted block stays in its sibling group and keeps its
slot** — the rule `reproject_dense_positions` states and the backend keeps.

Two tests, because the two undo paths are separate implementations and neither
covers the other: `undo_page_op` goes through `handlers/shared.ts`, while
`revert_ops` goes through `revert.ts`'s copies. The first version of the test
only drove `undo_page_op`, and reverting the `revert.ts` change left it green —
so it was proving nothing about the copies it was meant to guard. Both mutants
redden now, and so does the `old_position` one.

Two non-blocking notes taken as well: the sentence I had added to
`renumberSiblings` claiming the slot is "still counted among LIVE children only"
contradicted the very next fix and is gone, and `conformance-fuzz-bridge.ts` is
registered in `knip.json` `entry` — `npx knip` did flag it as an unused file,
which would have reddened `validate / lint`.
