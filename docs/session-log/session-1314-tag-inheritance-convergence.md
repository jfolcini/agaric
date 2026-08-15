# Session 1314 — tag-inheritance convergence: picking an arbiter, and the RemoveTag path that had none (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + review round (PR #3924) |
| **Items closed** | `#3876`, `#3923` |
| **Tests added** | 0 new (fixture repaired in place; existing convergence tests now falsify correctly) |
| **Files touched** | 8 (7 in #3924 + 1 doc-comment follow-up) |

**Summary:** `block_tag_inherited` had three independent maintainers —
`rebuild_all` (the full-vault recompute), `recompute_subtree_inheritance` (move
/ restore), and `remove_inherited_tag` (RemoveTag) — and they disagreed about
one specific shape: a block that holds a tag **both directly** (`block_tags`)
**and by inheritance** from a live ancestor. `rebuild_all` kept the inherited
row in that case; the two incremental maintainers each carried a `NOT IN
block_tags`-style exclusion that dropped it. This session settled which
definition is correct, fixed the two incremental paths to match it, and
during review chased down whether the fix needs a backfill migration for
vaults that already hit the bug.

## Why `rebuild_all` was the arbiter, not a coin flip

The three maintainers disagreeing doesn't by itself tell you which one is
"right" — a plausible bug could equally be that `rebuild_all` is the odd one
out. What settled it: three independent things in the codebase already
assumed the keep-both-rows semantics *before this PR touched anything*.

- Migration `0021`'s own backfill query (the one that populates
  `block_tag_inherited` from scratch on first install) does not exclude
  direct holders — read from the migration text itself, not inferred.
- `list_inherited_tags_for_block`'s docstring already documented that a tag
  can appear in both the direct and inherited lists.
- `useBlockTags.ts` on the frontend already does
  `inheritedIds.filter((id) => !direct.has(id))` — code that only makes sense
  if the backend is expected to hand back overlapping rows for the frontend
  to de-duplicate.

So the "keep" semantics wasn't a new decision this PR made — it was already
the load-bearing assumption everywhere except in two SQL exclusions that had
drifted from it. `rebuild_all` was corrected as the arbiter because it was
already the one path outputting what everything downstream of it assumed.
The other precondition — that keeping both rows can't cause double-counting
— was checked by tracing every consumer rather than assumed: every
"has tag T including inherited" read is a `UNION` or `EXISTS`, and the one
real count in the schema (`tags_cache.usage_count`) is `COUNT(*)` over
`block_tags ∪ block_tag_refs` and never references `block_tag_inherited` at
all.

## RemoveTag had no rebuild backstop — restore did

Both `recompute_subtree_inheritance` (move/restore) and `remove_inherited_tag`
(RemoveTag) carried the same wrong exclusion, but they are not equally
dangerous, because of one fan-out asymmetry:

- A content-block **restore** always retains `RebuildTagInheritanceCache` in
  its fan-out (`CONTENT_RESTORE_REBUILD_TASKS`) — so even before this fix, a
  wrong row from the restore path would heal on the very next restore-driven
  rebuild.
- **RemoveTag** does not. `invalidations_for_op`'s `AddTag | RemoveTag` arm
  only pushes `RebuildTagInheritanceCache` `if matches!(op_type,
  OpType::AddTag)` — RemoveTag was carved out of that back in #2669, on the
  strength of a test asserting the incremental update was already
  byte-identical to a full rebuild. It wasn't, for this one shape. A row
  RemoveTag dropped wrong was therefore **durable**: nothing in the normal
  fan-out would ever touch it again.

This is why #3923 (the RemoveTag fix) is the substantive half of this PR and
#3876 (the restore fix) is closer to a consistency cleanup — restore's wrong
rows were already self-correcting, RemoveTag's were not.

## The test #2669 relied on had the right shape and the wrong fixture

`remove_tag_incremental_matches_full_rebuild_2669` is exactly the test you'd
want to catch this: run the incremental path, run a full `rebuild_all`,
assert they match. It's the kind of test that *should* have caught the
exclusion bug outright. It didn't, because its fixture had no descendant that
held a tag of its own — the `NOT IN block_tags` exclusion the bug depends on
never had anything to exclude, so the assertion was true vacuously. The fix
here wasn't a new test; it was adding one block to the existing fixture that
*does* hold its own tag, which turns the same assertion into one that
actually exercises the exclusion (confirmed red with the old code reinstated,
green with the fix). Worth remembering as a pattern: a convergence test
between "the incremental path" and "the ground truth" is only as strong as
its fixture's coverage of the divergence classes — matching *shape* is not
enough to trust the test.

## Does an existing vault self-heal, or does it need a migration?

Review flagged (correctly) that this PR ships no backfill: a vault that hit
the RemoveTag bug before upgrading still has whatever rows were wrongly
dropped, and nothing here retroactively rescans `block_tag_inherited`. The
question worth writing down for the next reader: does that matter?

Traced it rather than assumed it (see the comment on `remove_inherited_tag`
in `agaric-store/src/tag_inheritance/incremental.rs` for the full argument).
The short version: every row this bug could drop belongs to a block that
*also* holds the tag directly — that's exactly the shape the exclusion
targeted. For such a block, the missing inherited row is provably invisible
to every consumer (the `UNION`/`EXISTS` read paths and the chip-UI
subtraction both make the direct row alone sufficient) for as long as that
block keeps the tag directly. The moment that changes — the block's own
`remove_tag` runs again — the FIXED code recomputes that block's row fresh
from the live ancestor chain rather than trusting whatever was in the table
before, so the same event that would ever make a dropped row observable is
also the event that repairs it. Independently, any `add_tag`, any
`restore_block`, or a `delete_block`/`purge_block` of a non-`"content"`-hinted
block fires a whole-vault `RebuildTagInheritanceCache` that heals it as a side
effect, and those are common enough in an actively used vault that
convergence usually arrives well before a specific block's own tag is
re-touched. Conclusion: no bounded SLA, but also no migration — a dropped row
is inert, not wrong-and-visible, so there is nothing for a migration to
urgently fix. Filed as a doc comment rather than a schema change; flagged to
the requester rather than shipped unilaterally, per the standing "don't
migrate without asking" instruction for this kind of finding.

**Files touched (this session):**
- `src-tauri/agaric-store/src/tag_inheritance/incremental.rs` (both the
  #3923 fix and this session's backfill-rationale doc comment)
- `src-tauri/agaric-store/src/tag_inheritance/rebuild.rs`
- `src-tauri/agaric-store/src/tag_inheritance/tests.rs`
- `src-tauri/src/command_integration_tests/conformance.rs`
- `src-tauri/src/materializer/coordinator.rs`
- `src-tauri/src/materializer/dispatch.rs`
- `src/lib/tauri-mock/handlers/tags.ts`

**Verification:**
- `cargo nextest run --workspace` → 5747 passed, 6 skipped (PR #3924).
- This session: `cargo nextest run --workspace -E 'test(tag_inheritance) or
  test(remove_tag) or test(3923) or test(2669)'` → 71 passed, 0 failed
  (comment-only follow-up change).
- `cargo fmt --all -- --check` clean both times.
- `cargo clippy --workspace --all-targets` clean, 0 warnings (PR #3924).

**Falsification (PR #3924):** restoring the #3876 exclusion reddens both the
move/restore convergence tests and the conformance test; restoring
`remove_inherited_tag`'s one reachable exclusion (site 2 of 3) reddens both
#3923 tests. Restoring all three exclusions together still leaves
`agaric-store` + `agaric-engine` green (1717/1717) — confirming the other two
sites are unreachable in production rather than merely untested, which is why
they were removed for rule-consistency rather than flagged as live bugs.
