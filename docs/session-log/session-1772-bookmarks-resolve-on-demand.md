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
forever, so a `lookedUpKeys` set records what was ASKED about and answered,
marked before the store write so one render sees both. A rejected IPC
deliberately leaves its ids pending: an id we never got an answer for must not
count towards the empty state, which is the difference between "still loading"
and the bug this fixes.

## Verified

- `npx vitest run src/components/layout/__tests__ src/stores/__tests__/resolve.test.ts`
  — 9 files, 251 passed.
- `npm run typecheck` — clean.
- `npx playwright test e2e/bookmarked-pages.spec.ts` — 8 passed, against the
  pre-installed Chromium.

Four tests are new, three reworked. Each was shown red before being trusted:

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
