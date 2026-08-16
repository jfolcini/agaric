# Session 1339 — what the conformance ratchet's green was actually worth

Five issues, all of the same species: a check that passes without checking. Two decorative
fixture steps (#3976, #3977), one waiver whose justification was never read (#3964), one
manifest that compared a label to a label (#3965), and one leg of the harness that had no
vacuity guard at all (#3966). Every premise held. Two of them held harder than the issue
that filed them expected.

## The two decorative units were decorative for the reason claimed

`filtered_blocks_query::value-text-in` filtered `status` with `valueTextIn: ["open",
"closed"]` over a seed whose only three `status` values were `open`, `closed`, `open`. The
IN predicate had no negative control: the key-presence gate already selected exactly those
rows, so deleting the membership test returned the identical set. `load_page_subtree_walks_
page_id` had the same shape one level over — every active non-root block in its fixture
already carried `page_id === rootBlockId`, so the walk predicate had nothing to get wrong.

Both were confirmed by mutation before anything was changed: with the `valueTextIn` guard
short-circuited to `false` **and** the `page_id` predicate deleted from the mock, the whole
conformance file was green at 56/56. Seeding one block with `status: "archived"` and one
active block belonging to a *different* page fixed both. Re-applying each mutation now
reddens, naming the fixture and the extra row: `+ "B7"` in the IN result, and `+ B6#page_id=B5`
plus `total_count 2 → 4` in the subtree walk. The second one also lands at position 1, so a
dropped predicate corrupts the head of an `ordered` list rather than its tail.

## The snapshot leg's guard found offenders the issue said it did not have

#3966 was filed honestly as an absence — "I looked, found no guard, and found no
counterexample either" — and explicitly declined to estimate whether the gap was reachable.
It was reachable. The sweep it asked for found **two live fixtures**, immediately, on the
first run of the new guard:

- `restore_block` — delete S2, restore S2. A pure round trip ending byte-identical to the
  seed. Its recorded `expected` was the snapshot the seed alone produces, so a mock whose
  `delete_block` *and* `restore_block` were both no-ops reproduced it exactly. This is the
  fixture two batch waivers (`restore_blocks_by_ids`, `restore_all_deleted`) cite as their
  coverage.
- `delete_property_reserved_key_clears_column` — set `todo_state`, delete `todo_state`. Same
  shape, and it carries the `reserved-key-clears-column` required scenario.

Neither was waived. Both were given a second block that the ops treat differently: a
`casualty` deleted and never restored, and a sibling whose `todo_state` is never cleared.
The terminal states (S2 active / S3 tombstoned; S2 null / S3 `DONE`) are now reachable only
if both ops ran *and* were scoped to the block they named — a no-op reddens, and so does an
over-broad one. Both directions, not one.

The guard's own trap was worth more attention than the guard. The obvious implementation —
"the snapshot must differ from the seed-only snapshot" — passes trivially for every fixture
with an op, because `op_log_digest.count` moved from 0 to N. That check cannot fail on
anything it exists to catch, and shipping it in this batch would have been the joke telling
itself. The comparison drops `op_log_digest` and consults only the projected domain
(`blocks` / `properties` / `block_tags` / `page_links`), with an in-tree test pinning that
exclusion in both directions.

After the tree was clean, a constructed probe (seed a property, then `set_property` the same
value) was recorded with `CONFORMANCE_UPDATE=1` and the guard caught it. Worth stating what
that recording looked like: the probe's `op_log_digest.count` was **2**, so the naive
whole-snapshot comparison would have passed it. The probe was deleted.

One fixture, `query_list_blocks_pagination`, has no ops at all. It is not flagged, and the
reason is written into the guard rather than left implicit: its snapshot leg still
differences the two *seed loaders* — `page_id` root resolution, position defaults, the
reserved columns — which is a real if narrow claim, and #1775 was exactly a seed-loader
divergence. What a zero-op fixture cannot carry is evidence about an op, so its evidence has
to live in its query steps. A fixture with neither is what the check now forbids.

## Three waivers cited a file that never mentions the command they waive

#3964 asked for the citation in a waiver reason to be checkable, at minimum for existence.
Existence turned out to be the weak half. A `git rm` is not how a citation goes wrong; it
goes wrong by being written from memory. Adding the relevance check surfaced three:

- `undo_page_group` was "regression-guarded by undo-op-refs.test.ts". That file's own module
  doc scopes it to `undo_op` / `undo_ops` and it never mentions `undo_page_group`. The only
  test in the tree that names the command drives the FE store against a **mocked** `invoke`,
  so it never reaches the mock handler. The mock's `undo_page_group` has no mock-level
  regression test at all, and the reason now says so.
- `restore_page_to_op` was "regression-guarded by revert.test.ts". `revert.test.ts` pins
  `applyRevertForOp`; the mock's `restore_page_to_op` is a **constant stub** returning
  `{ops_reverted: 0, non_reversible_skipped: 0, results: []}` and never calls it. There is
  no behaviour to guard, and the citation implied there was.
- `undo_ops` and `revert_ops` cited `revert.test.ts` legitimately but indirectly — they
  reach it through `applyRevertForOp` rather than by name. That is what the explicit
  `file.test.ts (via applyRevertForOp)` form is for: it redirects the relevance check onto
  the named symbol instead of exempting the entry. Pointing it at a symbol that does not
  exist reddens.

The guard also covers fixture citations (`batch of add_tag (tag_add_remove.json)`), which
are the same unverified reference in a different costume and outnumber the test-file ones.
For those the needle is the *other* command the reason names, matched against the fixture's
`"command": "…"` op entries — a fixture is never cited for the command it waives, which is
precisely why that command needs a waiver.

**The bug the falsification found in the guard itself.** The first version scanned the raw
reason string for command names. Fixtures are conventionally named after the op they drive,
so `restore_block.json` contains the substring `restore_block` — every fixture citation
satisfied itself off its own filename, and that half of the guard could not fail. It went
undetected through a green run and was found only by constructing the failure: repointing
`add_tags_by_ids` at an unrelated fixture and getting a green. The reason is now scanned with
its citations stripped. This is the entire argument for demonstrating a guard red rather than
observing that it passes, in the batch about exactly that.

## REQUIRED_SCENARIOS: what it can check, and what it still cannot

`REQUIRED_SCENARIOS` credited a fixture for a scenario because the fixture's own `scenarios`
array named it and because it happened to drive the right op. Label against label. The
sixteen tuples now carry a non-optional structural `holds` predicate over the fixture's seed,
its op args, and the recorded snapshot — the issue's option 1.

The predicates say something the (declares-scenario + drives-op) pair does not, which is the
bar; a predicate that re-states "drives `purge_block`" would be an assertion restating its own
precondition and is worse than none, because it reads as one. `tag-dedupe-lww` demands two
adds of the same (block, tag). `tag-remove-single-edge` demands the removed edge be gone
*while a sibling edge on the same block survives* — a remove that dropped everything would
satisfy a weaker form. `cascade-active-subtree` demands one `delete_block` op leaving two or
more tombstones. `reserved-key-clears-column` demands the target's column be null *and*
another block keep its own, which is also what proves the preceding set actually wrote one —
and which only became expressible because of the #3966 fix to that same fixture.

Falsified as the issue asked: strip the duplicate add from `tag_add_remove.json`, leave the
`scenarios: ["tag-dedupe-lww", …]` tag in place, and the new check reddens naming the fixture
and the missing shape — while **the old label-vs-label check stays green**. That pair is the
finding. A second, structurally different case (dropping the tag satellite from
`purge_subtree_with_satellites`) reddens the same way.

The obvious way to defeat a mandatory predicate is `holds: () => true`, which satisfies the
type and restores the original bug. A meta-guard rejects any predicate true of every fixture
in the corpus (it separates nothing) or true of none (it describes a fixture shape that does
not exist). Replacing one predicate with `() => true` reddens it.

**What this does not do, said plainly.** `holds` proves a fixture is *shaped* like its
scenario. It does not prove the recorded `expected` is *correct* — the backend authors that,
and a fixture recorded after the behaviour broke would encode the break and still satisfy
every predicate here. Settling that needs option 2, a mutation tied to a named production
line, which is #3963's mechanism and should be built once for both. This closes "the label is
the evidence". It does not close "the recording is right", and the manifest's doc now says so
rather than leaving a reader to assume the stronger claim.

## What was deliberately not done

A phrase-based check on #3964 — forbidding "covered by" / "regression-guarded by" in a reason
that carries no resolvable citation — was designed and dropped. It fires on legitimate prose
(`import_markdown`'s "parsing covered by e2e" names a directory, not a file), and its only
real target is an author who deletes the path while keeping the claim, which is
indistinguishable from an author who rewrites the reason to say anything else. Every waiver
system bottoms out in a human-written sentence. Adding a check that looks like it closes that
and does not is the failure this batch is about, so it is recorded here instead of shipped.

`restore_page_to_op`'s constant stub was left as a stub. It is now accurately described
rather than implemented; implementing it is a separate change with its own conformance
question, and quietly widening the batch to cover it would have made the honest description
unavailable.

## Verification

`conformance.test.ts` 56 → 59, `conformance-coverage.test.ts` 18 → 21 (74 → 80 combined), all
of `src/lib/tauri-mock/` 500 → 509 across 28 files, and the Rust leg 65/65 under
`cargo nextest run --workspace -E 'test(conformance)'`. Every fixture value was re-recorded
by the Rust runner and then re-derived by hand before being accepted — regeneration records
whatever the code does, including whatever it does wrong, and on this batch that mattered
twice.
