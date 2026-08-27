# Session 1412 — the space you were in when you clicked

Three issues that turned out to share a single shape: a space identity read at the
wrong moment, or not read at all. #4458 and #4450 are real user-visible bugs; #4462 is
the documentation around the same machinery, which had drifted into claiming more than
it could support.

## Captured, not current

`handleUndoRestore` in the history panel labelled its rename event with
`useSpaceStore.getState().currentSpaceId`, read live at the moment the user clicks Undo
in the toast. The restore it is undoing captured its own space earlier, at restore time.

Those are the same value in the common case, which is exactly why the bug survived: the
toast is short-lived and most users do not switch spaces while it is up. Restore in space
A, switch to B, click Undo, and the event goes out labelled B — for a block that lives in
A. The fix threads the captured `spaceId` through the toast's `onClick` closure instead of
re-reading the store.

The test has to distinguish the two readings rather than merely exercise the path, since a
test where both spaces are the same passes against either implementation. It restores in
A, switches to B, clicks Undo, and asserts *both* emitted events carry A. Reintroducing
the live read flips only the second entry — `['SPACE_A','SPACE_B']` against an expected
`['SPACE_A','SPACE_A']` — which is the signature that the second event is the one actually
exercising the change.

## The sibling that already knew

`handleMoveToSpace` published nothing to the name-change bus after a successful batch move.
Its sibling `handleTrash`, ten lines away, publishes a removal per id. So moving pages out
of a space left them in that space's warm `[[` cache, still offered by the picker, until an
unrelated space switch happened to invalidate it.

The fix mirrors `handleTrash` exactly, including its `NAME_CACHE_FANOUT_MAX_IDS` fallback
to a full `invalidateNameCaches()` for large batches. The interesting part is the direction:
eviction must scope to `currentSpaceId`, the ORIGIN, not `selectedSpaceId`, the destination.
Scoping to the destination is the natural-looking mistake and it is a no-op — the moved
pages were never in the destination's cache to begin with.

## What a present-id assertion is worth

The end-to-end test asserts the moved id is absent from the origin cache and a control id is
still present. The pair looks like it rules out two failure modes at once: "the cache was
never populated" and "the fix evicted everything."

It only rules out the first. Review probed the second by replacing the per-id removal with
an unconditional `invalidateNameCaches()`, and the test still went red — but on the *absent*
arm, not the *present* one. A full wipe self-heals in this harness: the list refetches
synchronously from a static mock and brings both ids back. So the control id can never fail
on its own, in any scenario that could be constructed for it.

The test suite does catch over-eviction — the sibling test counts one removal event per id,
which is a direct measurement rather than an inference from the resulting cache. Nothing was
broken. What was wrong was the comment, which credited the control assertion with a
guarantee it does not provide. That is precisely the defect class #4462 exists to correct,
appearing in the same PR that corrects it, so the comment now states what each arm does and
does not establish and points at the test that really pins narrowness.

This is worth generalising: *asserting a control value is unchanged proves nothing unless a
mechanism exists by which it could have changed.* Where the harness heals the damage before
the assertion runs, the control is decoration.

## Rationale that outran its path

#4462's remaining items are corrections to prose. The substantive one: `page-rename.ts`
justified threading the space with a scenario — a rename started in space A while the user
switches to B would be labelled B and let into B's warm cache, aborting an in-flight B fill.
Neither half happens for the `renamed` kind. The generation bump is unconditional and runs
before the space check, so the B fill aborts either way; and the renamed arm is
`if (!present) return list`, so an A-space id never enters B's cache at all. The argument is
sound for `added`, which appends into a warm cache, and was transplanted onto a path that
only ever emits `renamed`.

Threading the space is still right. Only the justification was over-claimed — which matters
more than it sounds, because an over-claimed rationale is the thing a future reader checks
the code against, and this one would have sent them looking for a behaviour that cannot occur.

The citation fixes are mechanical but were re-derived against the *final* state of the files
rather than against the issue text, since the fixes above moved lines. Two anchors the diff
shifted itself were caught that way. One item — the "five callers" count — was already
correct in the file; the wrong number lived only in a historical PR body, so nothing was
edited.

## Coverage that was asserted but not held

The `#4391` describe block pinned the `added` and `removed` space-drops while its own comment
claimed the guard generalises past `added`; `renamed` was unpinned. And nothing asserted that
`invalidateNameCaches()` still clears both caches when the active space differs or is `null` —
the `change.kind !== 'invalidated'` exemption is documented as deliberate in three docblocks,
but if it were ever folded into the space comparison, sync and MCP writes would silently stop
invalidating with no test to notice. Both are now pinned, and both were falsified by making
exactly those mutations.

## What shipped

- #4458 — the restore-space capture, plus a test that distinguishes captured from current.
- #4450 — origin-scoped cache eviction on batch move, mirroring `handleTrash`.
- #4462 — the coverage gap closed, and five documentation corrections re-derived against
  the final file state.
- A corrected comment about what the control assertion in the new e2e test actually proves.
