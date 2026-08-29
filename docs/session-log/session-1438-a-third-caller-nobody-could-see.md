# Session 1438 — a third caller nobody could see

#4524 asked for the `[[` picker's name-cache eviction to be extended to the block tree's
multi-select delete. The interesting part is not the extension — it is why the gap was invisible
from both sides of it.

## Two files that overlap in behaviour and nowhere else

`PageBrowserBatchToolbar.handleTrash` and `useBlockMultiSelect.handleBatchDelete` run the **same**
backend command, `delete_blocks_by_ids`, with the same cascade semantics. The toolbar has
published removals to the name bus since #4007 and gained the cascaded cohort in #4480. The hook
published **nothing** — not the selected roots, not the descendants — so a page trashed from the
block tree went on being offered under `[[` for the rest of the session.

Nothing about that asymmetry was visible from either implementation. They are two files that
happen to agree on a behaviour; there is no shape in the code where "and the other one does this
too" could have shown up. The hook even carried a comment explaining, correctly at the time, that
it maintained no name cache and so had nothing to keep consistent — a claim about this surface
that was true of its own state and false about the app's.

That is the argument for making the policy a **function** rather than a documented recipe: a call
to `notifyPagesRemoved` is a thing a reviewer can notice missing. A three-line recipe is not.

## The recipe was already duplicated, which is how you find out it is a policy

Before extracting anything, the recipe existed twice inside the toolbar itself — once in
`handleTrash`, once in `handleMoveToSpace`. Three decisions live in those three lines, and each
is individually gettable-wrong:

- **De-duplication.** Callers union their own id list with a backend cohort that *echoes it
  back* — `affected_page_ids` contains the selected roots — so duplicates are the normal input
  shape, not an edge case, and an array-shaped fan-out emits every root twice at
  O(listeners × pages) each.
- **The budget is measured on what will actually be emitted.** #4480 made the emitted set
  *larger* than the selection, so 20 selected roots cascading to 30 pages must collapse to one
  invalidation. `handleMoveToSpace` checked `ids.length`, which would wave 30 synchronous events
  through under a cap of 25 — correct only because the move mirror genuinely has no cascade.
  Inside the shared function the check is on the de-duplicated cohort, so the next caller cannot
  inherit the version that was safe by coincidence.
- **An empty cohort publishes nothing** — not an invalidation. No page was removed, so there is
  nothing for the picker cache to be wrong about.

That last one is not tidiness; it is load-bearing for the new caller, and it is the part the
extension could most easily have got backwards.

## Where the hook must NOT copy the toolbar

The toolbar's selection is pages by construction — it is the Pages view. A block-tree selection is
mostly **content** rows, which the picker never offers. Publishing them wholesale would fire
O(listeners × pages) of synchronous work per id that cannot match anything, and — worse — a
routine 30-block content delete would exceed `NAME_CACHE_FANOUT_MAX_IDS` and wipe a warm cache to
describe the removal of nothing. Combined with the empty-cohort rule, a `spaceId == null`
content-only delete would have dropped both caches for no reason at all.

So the hook publishes the **union of two halves**, and both are needed:

- `affected_page_ids` from the backend — the page membership of the cascade. The recursive CTE
  walks `parent_id` with no page-boundary stop, so deleting a block tombstones nested pages the
  user never selected. Only the backend can see that set; re-deriving it from `getDragDescendants`
  is exactly how two arms drift apart, and it would be wrong besides, because the store holds only
  the loaded page's rows and not the subtree of a nested page.
- the **page subset** of the selection — a selected id the backend skipped (missing, or
  soft-deleted by a concurrent write) is absent from the reported cohort but was in the user's
  selection and is not a live page either way. `block_type` is already on the rows in the store,
  so the filter is one map lookup per id — read *before* the splice that drops those rows.

## The space id is a prop, not a read

`currentSpaceId` arrives as a hook parameter, mirroring the toolbar's, rather than as a
`useSpaceStore.getState()` read taken at emit time. The bus's module docblock already settles why:
the space an event is labelled with must be the one that was live when the user **acted**. A fresh
read after the `await` would label the batch with whatever space the user switched to while the
IPC was in flight, which is worse than no scoping — it tags a foreign-space row as belonging to
the current space and the subscriber applauds it in.

Closing over the prop and listing it in the callback's dep array is what pins that. In `BlockTree`
the selector moved *above* the hook that consumes it, from its old site next to
`batchPropertiesInvalidationKey` (which still uses it) further down.

## The threshold constant moved with the policy

`NAME_CACHE_FANOUT_MAX_IDS` was exported from `PageBrowserBatchToolbar`, which was the right home
while the toolbar was the only bulk publisher. It now lives in `name-change-bus.ts` next to the
function that enforces it, with its measurement table intact — the timings are still the reason
the number is 25 rather than a round guess, and they belong wherever the check is.

## Verification

`notifyPagesRemoved`'s own suite pins the policy in isolation: one scoped event per id below the
budget, de-duplication, the budget measured on the collapsed cohort, the null-space fallback, and
the empty cohort emitting nothing. The two caller suites pin the end-to-end behaviour, including
the content-row filter and the cascade union.

84 tests across the three suites, green. Two falsifications run here, each against a copied
backup with the restore proven byte-identical by `cmp`:

- removing `notifyPagesRemoved`'s empty-cohort early return reddens **2** — the policy's own
  empty-cohort case and the hook's null-space content-only case, which is exactly the pair the
  rule exists for, one at each level;
- removing the hook's `block_type === 'page'` filter (publishing the selection wholesale) reddens
  **2** in the hook suite, both of them "publishes nothing" cases. Worth noting what that does
  *not* prove: no arm goes red for the fan-out being merely *wider* than it should be on a mixed
  selection, only for it being non-empty when it should be empty. The empty case is the one with
  a user-visible consequence (a wiped warm cache), so this is a real gap and a narrow one.

Closes #4524.
