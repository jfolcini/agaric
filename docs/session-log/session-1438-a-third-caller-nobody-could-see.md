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
routine 30-block content delete (a live space, so a genuinely warm cache) would exceed
`NAME_CACHE_FANOUT_MAX_IDS` and wipe it to describe the removal of nothing.

The empty-cohort rule's own null-space case needed a correction after review: a first pass here
argued that without it, a `spaceId == null` content-only delete would drop a warm cache. It
wouldn't — `name-change-bus.ts`'s "When the caller has NO active space" section already establishes
that with no active space both picker caches are provably empty (the space-switch subscriber clears
them on any transition to `null`, and both lazy fills refuse to fill while `null`), so there is no
warm cache there to lose. What the guard actually buys, once that's accounted for, is smaller: with
a live space the per-id loop already emits nothing for an empty cohort regardless (there's nothing
to iterate), so the null-space branch is the *only* branch it changes, and there it skips an
`invalidateNameCaches()` that would otherwise be a real event but a pointless one — a synchronous
fan-out to every mounted `useBlockResolve` announcing a removal that never happened. Worth keeping
for that, not for a cache loss that can't happen in that state.

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

## Round 2 — the empty-cohort rule was right for a reason I had wrong

Review approved this and then took apart my justification for the empty-cohort early return,
correctly. The `notifyPagesRemoved` docblock and the hook's inline comment both said it was
load-bearing because a `spaceId == null` content-only delete would otherwise "drop a warm cache to
describe the removal of nothing". Ten lines up, the same module argues that with no active space
both name caches are **provably empty**. Two passages in one file arguing opposite things about the
same state, and mine was the wrong one.

Checked the "provably empty" claim by reading the code rather than trusting either passage:
`searchPagesViaCache` and `searchTags` both short-circuit to `[]` while the space is `null`, and the
space-switch subscriber clears both refs on any `currentSpaceId` transition *including* one to
`null`. It holds.

So what does the early return actually buy? With a live space the per-id loop already emits zero
events for an empty cohort, making the guard a no-op there. The **only** branch it changes is
`spaceId == null`, where it suppresses an otherwise-unconditional `invalidateNameCaches()`. And
since those caches are already empty, that suppressed call was never rescuing a warm cache — it was
a pointless synchronous fan-out describing a removal that did not happen. The rule survives; the
reason for it does not. Both passages now say the true one.

Worth keeping as a shape: a rule can be correct and its stated justification can be false, and the
combination is more dangerous than a wrong rule, because the next person extends the rule by
reasoning from the justification.

### Three more, and one declined

**A type hole.** `notifyPagesRemoved(pageIds: Iterable<string>)` accepted a bare `string` — a
slipped `notifyPagesRemoved(id, spaceId)` would type-check and fan out one removal event **per
character**. Narrowed to `readonly string[] | ReadonlySet<string>` and pinned with a
`@ts-expect-error` test. Falsified: reverting the signature makes `tsc -b` fail with "Unused
'@ts-expect-error' directive" at that exact line, which is the assertion doing its job in the only
direction it can.

**A value read after the await.** The hook read `pageStore.getState().blocksById` *after* the IPC,
so a store reload mid-flight silently dropped the page-subset half of the union. Captured before the
await now, alongside `ids`, applying the discipline this PR argues for `currentSpaceId`. The impact
claim was verified rather than repeated: `affected_page_ids` is read backend-side from the same
`union_cohort_json` the soft-delete `UPDATE` consumes, so it provably covers every page actually
deleted, and the frontend subset only ever adds ids the backend **skipped** — meaning the old
ordering could only under-evict a page that was not live anyway. Small, real, and now stated at that
size. Pinned with a deferred-promise mock simulating the mid-flight reload.

**A redundant `Set` at the call site**, now that the shared function de-duplicates.

**Declined: copying the caller's `Set`.** The narrowed type stops the *function* mutating, not a
caller mutating its own set elsewhere — so note 1 does not make this moot. No current caller retains
and mutates one, and the dispatch is synchronous with no `await` inside it. Documented as a tradeoff
with the instruction to copy at the call site if that ever changes, rather than paying for a defence
against a caller that does not exist.

86 tests green; `tsc -b` clean.

## Round 3 — the eviction had no restore, and the obvious test was green over it

Review found one blocking defect, and it was mine: this PR added a third **evicting** publisher and
not its mirror. `handleBatchDelete` now drops pages from every mounted `pagesListRef`, marks the
batch undoable two lines later, and raises a toast advertising Ctrl+Z as the escape hatch. Nothing
on that undo path put the pages back.

Traced the whole chain rather than trusting the report, and every link held:

- Ctrl+Z → `performPageUndo` → `useUndoStore.undo()` → `refreshAfterUndoRedo`. The only bus event
  emitted anywhere in that chain is a single `renamed` for the open page, via `renamePage`.
- `applyPageNameChange`'s `renamed` arm is `if (!present) return list`, so a rename provably cannot
  re-add a row that `removed` filtered out. The two events are not substitutes.
- The lazy refill is gated purely on `source.length === 0`. A warm list with one row filtered out is
  still "filled", so nothing refetches. The generation bump discards an in-flight fill; it never
  clears the ref. The space-switch subscriber needs a real `currentSpaceId` transition, which an
  undo is not.
- `commands/history.rs` emits no Tauri event, so `useSyncEvents`' `invalidateNameCaches()` does not
  fire for a local undo either. (Checked: the file contains no `.emit(` at all.)

So the page came back in the DB and in the tree, and stayed missing from `[[` for the rest of the
session. Stale-**absent** is the worse polarity of the class #4007 exists to close: the user can see
a page they cannot link to, and unlike a stale name nothing on screen hints at why.

### The general rule this is an instance of

Every publisher that removes rows from a cache owes a restore signal to whatever can reverse it.
The repo already treats them as a pair on both other delete surfaces — `handleUndoTrash` and
`usePageDeleteAction.handleUndo` each call `invalidateNameCaches()` next to their restore, both with
comments saying why. The reason it went missing here is the same reason #4524 existed at all: the
pairing lives across two files that never mention each other, so "and this one owes a restore too"
has no place in the code to show up. The fix goes in `refreshAfterUndoRedo`, which is the single
choke point every undo route funnels through (`performPageUndo`, `performActivePageUndo`, the
swipe-to-delete toast) and the redo branch as well.

It is a blanket invalidation, not a targeted re-add, for the reason `usePageDeleteAction.handleUndo`
already writes down: the undo store is ref-addressed and reports only an op *type*, so it cannot
name the rows a reversal restored, and a delete cascades to nested pages besides. An empty cache
means "not fetched for this space yet", so re-adding the one id we could name would latch a partial
list as the whole space. It sits **before** the title-refresh `try`, not inside it — that block
swallows its own failures by contract, and ordering the drop after `getBlock` would silently make a
correctness obligation conditional on a best-effort IPC. It stays gated on an op actually having
been reversed (`if (!result) return` upstream), so a Ctrl+Z with nothing left to undo does not throw
away a warm cache.

### The test trap — same shape as session 1433

`searchPages` routes a query of 3+ characters to `searchPagesViaFts`, which asks the backend. The
restored page is in the backend, so **a test that types three characters passes against the broken
code**. Only the ≤2-character path — the picker's initial open, the `[[` just typed — reads the
stale list, and only while that list is non-empty, because the refill is gated on emptiness. Delete
every page in the fixture and even the short-query test passes over the live bug.

That is session 1433's finding again with different machinery: the natural formulation of the
acceptance case is satisfied through a second, healthy path and never touches the broken one. There
it was a re-slice that destroyed the context carrying the bug; here it is a query length that
routes around the cache entirely. Both look like incidental details of how you'd write the test.

Both formulations are now in the suite, deliberately:

- `offers an undone page again on the ≤2-char cache path` — the real guard. `P_STAYS` is load-bearing
  twice over: it proves the cache was warm before the delete, and it keeps the list non-empty after
  the eviction so the refill gate stays shut.
- `would have found the undone page anyway once the query is long enough (FTS, not the cache)` — kept
  as an executable warning, with a comment saying it is expected to be green either way. Verified,
  not assumed: it passed in the falsification run with the fix disabled.

One correction to the report's wording: the FTS path does not "self-heal" — `searchPagesViaFts`
reads `pagesListRef` for its supplement but never fills it, and there is a standing `#4337 item 3`
note saying so. The stale cache survives a long query untouched. What self-heals is the *result*,
which is all it takes to make the test useless.

### Verbatim RED

Falsified against a copied backup, restore proven byte-identical with `cmp`:

```
FAIL  src/components/block-tree/__tests__/use-block-multi-select.test.ts > useBlockMultiSelect handleBatchDelete — name-cache fan-out (#4524) > offers an undone page again on the ≤2-char cache path
AssertionError: expected [ 'P_STAYS' ] to include 'P_ROOT'
```

Three more went red with it in `useUndoShortcuts.test.ts` (the undo and redo invalidation arms, and
the existing #4391 straddle test, whose event count is now two). The 3+-character test and the
"reversed nothing" arm stayed green, as designed.

### The other three notes

**Declined — `HistoryPanel`'s restore is not the same shape.** It looked like the same missing
invalidation, but that panel is `edit_block`-only: `getRestorableText` returns `null` for every other
op type, and both the row filter and the handler gate on it. It can revert a page's *title text*; it
cannot resurrect a deleted page. So the page it acts on is present in the cache by construction and
the precise `renamed` event `renamePage` already emits is the correct signal — adding a blanket drop
there would throw away a warm cache on every title revert to fix nothing. The `renamed` arm's bail on
an absent id is the bus's general contract, not a defect of this surface.

**Documented — the over-cap fallback clears the tag cache too.** Past
`NAME_CACHE_FANOUT_MAX_IDS`, and on the null-space branch, `notifyPagesRemoved` emits `invalidated`,
which is not entity-scoped: `applyTagNameChange` returns `[]` as well, so the `#` picker's
`tagsListRef` goes with it for a delete that removed no tag. Consistent with the toolbar's policy
since #4007, and the cost is a re-fetch rather than a wrong suggestion — but it is new on this
surface and the hook's comment did not mention it. It now does, along with the point that on a block
tree it is the page-subset filter, not the cap, that keeps an everyday content delete from reaching
that branch at all.

**Fixed — a type-narrowing hole in the new mid-flight-reload test.** `done` and `releaseFirst` were
declared `T | null` and assigned only inside `act()` callbacks. TypeScript's control-flow analysis
does not see an assignment made in a nested function, so at the use sites both were still narrowed to
`null`: `await done` type-checked as `await null` and `releaseFirst?.(...)` as a no-op optional call.
Right at runtime, unchecked at compile time — a refactor that stopped returning the promise would
have sailed through `tsc`. Confirmed with a standalone probe (`Eq<typeof done, null>` compiles under
the old shape; `Eq<typeof done, Promise<void>>` under the new one) rather than taking it on trust.
Both are now non-nullable with same-shaped placeholders; the resolver's placeholder **throws** so a
mock that is never invoked fails loudly, and an identity assertion after the `act` stops the promise
placeholder from turning a never-assigned `done` into a vacuous `await`. Two pre-existing
instances of the identical shape in the same file (the reentrancy-guard tests, which predate this
PR) were fixed with it, so the file does not carry a comment explaining a hazard three of its own
tests still have.

`tsc -b` clean. 344 tests green across the six suites covering the bus, both delete callers, the
undo path, `useBlockResolve` and `usePageDeleteAction`.
