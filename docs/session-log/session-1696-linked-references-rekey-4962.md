# Session 1696 — Linked References: invalidate instead of re-key, and stop vanishing on a failed read

#4962 is two defects in one panel. `useBacklinkGroups` carried the blanket
property counter `invalidationKey` inside its TanStack query key, so every
`block:properties-changed` — a TODO ticked anywhere in the vault — minted a new
key with `data: undefined`, painting `LoadingSkeleton` over the panel, dropping
every Load-more page back to page 1 and, because `LinkedReferences`'
`queryIdentity` embedded the same counter, re-seeding `groupExpanded` from the
`groups.length <= 5 || i < 3` default. That is the review flow the panel exists
for: read the backlinks while ticking the tasks they point at. Second, a
rejected `list_backlinks_grouped` settles at `loading === false`, `groups === []`,
`totalCount === 0`, which is exactly the panel's hide-when-empty guard — so a
read failure removed the whole section and told the reader nothing links to this
page, with a ~4s toast as the only other signal and no retry anywhere.

## The inherited diff

This session picked up uncommitted work from an interrupted builder: the counter
pulled out of the query key, a new generic `useInvalidateOnCounter` with
`useInvalidateOnGraphStructure` reduced to a binding over it, `refetch`
plumbed out of the hook, `invalidationKey` dropped from `queryIdentity` but kept
as a dep of the `clearCache()` effect, and the `gcTime` comment rewritten. The
error half — the guard, the `ListViewState` branch, and every test — was not
started. What follows is what that diff was reviewed into.

## Two hooks, not one

`useInvalidateOnCounter(counter, prefix)` holds the whole rule (first value is
the mount, a later move invalidates the prefix once) and
`useInvalidateOnGraphStructure(prefix)` is three lines binding it to
`useGraphStructureEvents()`. The wrapper earns its place because it is the one
place that knows *which* counter the graph axis is: its two callers
(`useBacklinkGroups`, `useUnlinkedReferences`) neither subscribe to the event
source nor can pass the wrong counter, and keeping it leaves both call sites and
its existing test untouched, which is the smaller change. It is not a
pass-through — the alternative is the same two lines duplicated at every caller.
Both hooks are tested: the wrapper keeps `useInvalidateOnGraphStructure.test.ts`,
and the generic gets its own two cases in `useInvalidateOnCounter.test.ts`.

## `clearCache` keeps `invalidationKey`; `queryIdentity` does not

The issue suggested a property write cannot rename a page, so the title-resolution
cache need not clear on one. It cannot rename, but `useBacklinkResolution` also
resolves a referenced block's TODO *status*, which a property write is precisely
what changes — and the resolution TTL is 5 minutes. So the two deps were split
rather than moved together: `invalidationKey` stays a dependency of the
`clearCache()` effect (re-resolving titles is cheap and correct) and is gone from
`queryIdentity` (re-seeding the user's expanded groups is neither). The one-line
reason sits at each site.

## The error half

`ListViewState` has carried `error` / `onRetry` since #3306 and renders
`ListErrorState` — a `role="alert"` card with a Retry button — so the panel needed
no new component: `&& !isError` on the hide-when-empty guard so a failure keeps
the section, then `error={isError && t('references.loadFailed')}` and
`onRetry={refetch}` on the `ListViewState` already mounted. The sibling
`UnlinkedReferences` hand-rolls its equivalent card inside `empty={…}` (#3738);
this consumer uses the props instead, which is the same presentation with less
code. The header still reads "0 References" above the card, matching the
sibling's deliberate choice in #3738 note 1 — the count is honest about what was
loaded, and the body is now honest about why.

`LinkedReferences.test.tsx` case 35 asserted the opposite behaviour ("renders
nothing … even after error", from UX-152 whose scope was empty panels only); it
is flipped to expect the card, and a new case 35b clicks Retry and asserts the
backlinks appear — the durable effect, not the call shape.

## Verified

- `npx vitest run` over `useBacklinkGroups.test.ts`,
  `useInvalidateOnCounter.test.ts`, `useInvalidateOnGraphStructure.test.ts`,
  `LinkedReferences.test.tsx`, `UnlinkedReferences.test.tsx`,
  `useUnlinkedReferences.test.ts`: 6 files, 135 tests, all passed.
- `npm run typecheck`: exit 0. `oxfmt` / `oxlint` clean over the changed files.
- Falsified on a copy of each production file, `cmp`-clean after every restore:
  - `useBacklinkGroups.ts` back to main's shape (counter in the query key, no
    `useInvalidateOnCounter` call): `useBacklinkGroups.test.ts:289`
    `expect(result.current.loading).toBe(false)` — "expected true to be false".
    That is the skeleton flash, in one assertion.
  - The same mutation with the invalidate hook *left in place*:
    `useBacklinkGroups.test.ts:290` — groups `[ 'P1' ]`, expected
    `[ 'P1', 'P2' ]`, i.e. the lost Load-more page. The count gate above it was
    relaxed to `toBeGreaterThanOrEqual(3)` on purpose: under a re-key the
    invalidate races the new key's first fetch and the call count alone reddens
    for the wrong reason, which would have masked what the test is for.
  - `useInvalidateOnCounter.ts` without the `seenCounterRef` guard:
    `useInvalidateOnCounter.test.ts:32` and
    `useInvalidateOnGraphStructure.test.ts:37` — invalidated 1 time on mount,
    expected 0.
  - `useInvalidateOnCounter.ts` without the `invalidateQueries` call:
    `useInvalidateOnCounter.test.ts:43` — 0 times, expected 1; and both
    `useBacklinkGroups` refetch tests red with it.
  - `LinkedReferences.tsx` guard back to `!loading && totalCount === 0 …`:
    `LinkedReferences.test.tsx:1628` "Unable to find role=alert" and `:1664`
    "Unable to find role=button and name Retry".
  - `onRetry` removed: `LinkedReferences.test.tsx:1631` and `:1664`, no Retry
    button.
  - `onRetry={() => {}}` (button present, wired to nothing):
    `LinkedReferences.test.tsx:1668` — "Unable to find an element with the text:
    first block". The click has to *do* something, not merely exist.
- The pre-existing F-39 test survived both re-key mutations, as #4962 predicted —
  it asserts only that a second IPC fires, which a re-key also satisfies. It is
  kept (its stale "changes the query key" comment corrected) and the new case
  carries the distinction.
- Not run locally: the full vitest suite, Playwright, prek, the Rust lanes. No
  Rust, SQL or binding surface was touched. No e2e spec was added: both halves
  are pinned at the component level against the same mock backend an e2e run
  would use, so an `e2e/` spec would be a third copy of the same assertion.
