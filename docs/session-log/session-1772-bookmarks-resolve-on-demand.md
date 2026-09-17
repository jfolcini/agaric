# Session 1772 — the sidebar stops hiding bookmarks it never asked about

#5075. Bookmarking a page created in the same session did not add it to the
sidebar's Bookmarks section, and when it was the only bookmark the section
rendered "No bookmarks / Bookmark a page to keep it here" while `starred-pages`
in localStorage plainly held the id.

`BookmarksSection` filtered the starred list down to ids the app-wide resolve
cache already held and never asked for the rest. That filter is load-bearing —
the cache is keyed `(space, id)`, so it is also the space filter, and a
bookmark from another space must not show under the active one — but
`useResolveStore.preload()` runs only on boot, on a space switch and on
`sync:complete`. A page created during the session reaches none of them:
`usePageCreation` calls `notifyPageAdded`, whose only subscriber is the
BlockTree-scoped `use-block-resolve.ts`, not the global store.

The false empty state was the second half. The `spaceResolved` guard existed to
tell "no bookmarks here" from "titles have not loaded yet", and it asked
whether ANY entry for the active space was cached. With other pages cached it
said yes, so the section confidently claimed emptiness about a bookmark it was
itself hiding — the exact failure its own comment said it must not produce. It
covered a cold cache and not a warm cache missing one id.

Now the ids the cache does not hold are resolved on demand,
`batchResolve(pendingIds, { kind: 'active', space_id })` fed back through
`batchSet` — the same shape as the store's own targeted-preload path. Being
space-scoped, foreign-space ids drop out of the response and stay hidden, so
the barrier the old filter provided is preserved rather than reimplemented.
`spaceResolved` is deleted; the empty state gates on "every starred id has been
looked up".

Seeding the store at the `notifyPageAdded` call sites would have fixed this one
path and nothing else — a page synced from another device, or a bookmark
restored from storage before the first preload lands, fails identically.
Resolve-on-demand covers the class, so the seeding was deliberately not added.

The loop this invites is real and guarded: the store write that follows an
answer bumps `resolveVersion`, which recomputes the pending set. An id the
backend leaves out — another space's, or purged — would be re-requested
forever, so a set records what was ASKED about and answered, marked before the
store write so one render sees both. A rejected IPC deliberately leaves its ids
pending: an id we never got an answer for must not count towards the empty
state, which is the difference between "still loading" and the bug this fixes.

That set has to be scoped to the space, and the first version was not. Review
caught it: switching away flushes the space it leaves (`clearAllForSpace` in
`useAppSpaceLifecycle`), but this section never unmounts, so a space-shared set
outlives the cache it was a record of. Space A → B → A left the bookmark
uncached AND already marked asked, so it was neither rendered nor pending and
the empty state claimed the user had none — #5075's exact symptom, restored by
its own fix, and the case the deleted `spaceResolved` guard had covered. The
set now carries the space it was built for and is treated as empty when that
space changes. Pinned by a round-trip test with a scope-aware `batch_resolve`
mock, which also shows space B legitimately empty in the middle; sharing the
set across spaces reddens it with `Unable to find role="button" and name "Brand
New Page"`.

One more from the same review, not a defect but a cost: the memo recomputes on
every `resolveVersion` bump, and `batchSet` fires per page-picker keystroke
with a real change (#753), so an effect depending on a fresh array identity
cancelled the in-flight lookup and re-issued `batch_resolve` once per
keystroke. The memo returns a joined string now and the effect splits it back,
so an unchanged pending set is an unchanged dependency. ULIDs carry no spaces.

## Verified

- `npx vitest run src/components/layout/__tests__ src/stores/__tests__/resolve.test.ts`
  — 9 files, 252 passed.
- `npm run typecheck` — clean.
- `npx playwright test e2e/bookmarked-pages.spec.ts` — 8 passed, against the
  pre-installed Chromium.

Five tests are new, three reworked. Each was shown red before being trusted:

- empty-state gate broken → `expected <p class="text-sm font-medium">No
  bookmarks</p> to be null`, on both the still-resolving and the failed-IPC
  tests.
- resolve effect disabled → 5 red, including `Unable to find role="button" and
  name "Brand New Page"` and `expected "warn" to be called at least once`.
- `lookedUpKeys` marking dropped → `Unable to find an element with the text: No
  bookmarks`, which is what pins the loop guard.
- scope changed to `{ kind: 'global' }` → `expected { ids: ['A'], scope: {
  kind: 'global' } } to deeply equal … { kind: 'active', space_id: 'SPACE_B' }`,
  which is what pins the cross-space barrier.

The e2e spec was falsified the same way: emptying the pending set reproduces
the maintainer's exact output, `Expected substring: "Brand New Page"` against
`Received string: "BookmarksNo bookmarksBookmark a page to keep it here."`.

`e2e/bookmarked-pages.spec.ts` covered only the PageBrowser's Starred/Pages
grouping, with nothing exercising the sidebar section against a page created
in-session. That gap is why this shipped, and the repro now lives there.
