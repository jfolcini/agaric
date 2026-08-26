# Session 1401 — the create event the bus deliberately did not have

#4338. The name-change bus published renames and deletes but never creates, so a page
created anywhere outside a picker's own hook was invisible to every warm cache.

## The docblock forbade this, and it was half right

`name-change-bus.ts` documented that there is **deliberately no `'added'` event**, for
three reasons. They are not the same kind of reason, and reading them as one sentence is
what made the design look settled:

- **The empty-cache latch** — inserting one row into an unfetched cache would latch a
  one-row list as if it were the whole space. This is a property of the *apply*, and
  `recordCreatedRow`'s `if (listRef.current.length > 0)` guard is literally the fix. An
  `'added'` arm that honours the same condition leaves an unfetched cache unfetched, so the
  next picker read still re-fetches.
- **A restore cascades to descendants**, and **bulk paths report only a count** — these are
  properties of the *restore call site*, not of the event. They say the caller does not know
  the full set of rows that reappeared, so it cannot describe them one at a time.

A create knows exactly one row and describes it completely. So the amendment is not "the
objection was wrong" — it is that the objection covered two different things. The paragraph
now says the latch is answered by the subscriber honouring the same guard (and that a
subscriber which *cannot* make that promise must treat `'added'` as an invalidation), while
`invalidateNameCaches` remains the restore/sync path for the caller-ignorance reason, which
the old text had buried in a parenthesis.

Verified rather than reasoned: reverting `isEmpty ||` out of the disposition turns
`pagesListRef.current` from `[]` into a one-row list — the latch, reproduced.

## The steer I gave was wrong, and the mechanism says why

The brief for this work said ordinary "create Untitled and navigate to it" sites have no
picker relevance, and only a page created from a pasted `[[link]]` does.

That is false, and the reason is a mechanism rather than a preference:
**`applyPageNameChange`'s `'renamed'` arm bails on an id the list has never seen**
(`if (!present) return list`). So a page created-then-titled — the ordinary New Page → type
a heading flow — was dropped **twice**: once as an unpublished create, and then again as a
rename of an unknown id. It never entered a warm cache at all.

Publishing `'added'` is what makes the *existing* rename fan-out able to do its job for
young pages. There is a test pinning exactly that.

The backing fact: `list_all_pages_in_space`, the query that fills `pagesListRef`, filters on
nothing but `block_type='page' AND deleted_at IS NULL AND space_id=?` — no template filter,
no journal filter, no Untitled filter. A warm cache missing any of those rows is simply
wrong about the space.

## Ten call sites wired, one branch deliberately not

Templates publish **before** `setProperty('template')`, since the row is a page the moment
the create commits even if the property write fails — pinned by a test. The journal site
publishes at the create rather than in the deferred `isNewPage` group, because a cache
notification cannot race `autoCreateFirstBlock` the way a render notification can.
`WelcomeModal` publishes on the create branch only: usually there is no warm cache on first
boot, but "Show the welcome tour again" re-runs it mid-session, so the reuse branch stays
silent.

`TagList` already broadcast renames and deletes; create was its one silent mutation.

## The residual, recorded rather than fixed

The three in-hook paths still update only their **own** instance. The journal mounts one
`BlockTree` per day panel, so a page created via Monday's `[[`-picker "Create new page" is
invisible to Tuesday's cache. That is a real gap of the same class — but converting working
code to the bus newly fans creates out to siblings, which is a distinct behaviour change
deserving its own test, and #4338 scopes those two paths as already fixed by #4275.

Recorded in `notifyPageAdded`'s docblock with a pointer from `registerCreatedPage` — which
is also #4358's acceptance item, "record why once, somewhere a reader of
`registerCreatedPage` will find it".

## One deliberate asymmetry

The `'added'` apply appends **at the end, unsorted**, matching `recordCreatedRow` exactly
rather than the `'renamed'` arms' `.toSorted(…)`. Sorting would have been defensible, but it
would make a bus-announced create land in a different picker position than an in-hook one —
the "two creation sites with different invariants" shape that all of #4008, #4275 and #4319
are about.

## Falsification

Eight reverts, each restored and md5-verified. The ones that matter:

- **`'added'` arm removed** → 4 red, including the young-page rename test.
- **`isEmpty ||` dropped** → 3 red: the latch reproduced on both pages and tags.
- **`|| alreadyPresent` dropped** → a row a racing fill already delivered is duplicated.
- **`if (change.kind !== 'added')` on the generation bump** → the racing pre-create fill wins,
  which is the #4319 counterfactual.
- **All ten emissions neutralised** → 11 red, one per wired site (paste contributes two).
- **The negative arms hoisted out of their "only when actually created" conditionals** → the
  "publishes nothing" tests go red, so they are not vacuous.

## Two flakes caught rather than left

The palette and Ctrl+N tests used a fixed `await Promise.resolve()` count, but the emission
lands several microtasks deep in a `.then(unwrap).then(…)` chain — Ctrl+N passed in isolation
and failed in the full run. Both now use `waitFor`/`vi.waitFor`, each re-run three times green.

## Verification

Whole frontend suite: **783 files, 18065 passed**, 1 expected fail, 37 skipped. `tsc -b`
clean; `oxlint` clean across all 22 changed files. 22 files, +1003/−18.
