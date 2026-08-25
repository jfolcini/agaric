# Session 1395 — the picker's two answers to one question

Three issues (#4354, #4344, #4358) that all reduce to the same complaint: the picker's
answer depends on whether a cache happens to be warm, and the user has no way to know
which answer they are getting.

## #4354 — create-suppression compared the leaf, not the path

`appendCreatePageOptionIfNeeded` had two arms. The warm arm read raw page rows; the cold
arm read already-rendered `PickerItem`s, and `makePagePickerItem` runs every title through
`formatNamespacedLabel`, which keeps only the **leaf** of a namespaced path.

For a page titled `Engineering/Platform/Observability` that arm compared against
`Observability`, which broke in *both* directions:

- querying `Observability` on a **cold** cache **suppressed** Create, so the user could not
  create the page they asked for — and the row offered instead was a different page whose
  path merely ends that way;
- querying the full path **offered** Create for a page that already exists.

Which one you hit depended only on cache timing. Both arms now take raw `PageRow`s and
compare the full title, because the create option creates a *page*, and pages are
identified by their full path.

Pinned as a four-cell matrix — {warm, cold} × {leaf query, full-path query}. The two warm
cells were already correct; they are there so the half that regresses cannot drift. The
review mutation-tested the pair in both directions to confirm neither pair passes for an
incidental reason.

### The narrowing that had to be proved, not asserted

Moving the cold arm from `matches` to `rows` also drops the alias items that
`mergeAliasPrefixMatches` prepends. The author asserted this was behaviour-preserving
because alias labels read `"${title} (alias: ${x})"` and "could never be an exact match".

That is the kind of claim that is usually right and occasionally catastrophic, so it was
proved from the code rather than accepted: `untitledOr` guarantees the label is never bare
(a blank title yields `"Untitled (alias: x)"`, not `"(alias: x)"`), the backend match is
`alias LIKE '%q%'` so `|q| <= |alias|` always, and `foldForSearch` never deletes spaces,
parens or the colon — so the folded label is a strict superstring of a string already at
least as long as the query. Exact match is unreachable by construction. No alias item was
ever suppressing Create.

## #4344 part 2 — the sequence-guard loser served nothing

When the earlier-issued fill resolves **first** — the common case for in-order IPC on a
cold cache — it fails the #4270 tie-break, and the rejection branch read
`pagesListRef.current`, which no fill had written yet. That call returned **zero** pages
where its own valid, marginally-older snapshot was fine to serve: a flash-of-empty on
exactly the cold-cache fast-typing path.

Three collapsed conditions became a three-way decision. Space and generation say whether
the data is **servable at all**; the sequence only says whether it is the **freshest**:

- servable and freshest → persist and return
- servable, lost the tie-break → return, do not persist
- not servable (space switched, or generation bumped) → refuse, unchanged

The relaxation is one mistake from leaking another space's rows into the picker, so the
guard tests were falsified in the over-relax direction too — serving on *every* rejection
must redden them. It does; the space-switch test shows the old space's tag arriving in the
new space's picker.

`searchTags` had the identical defect. It was fixed here rather than filed, because the
design question had already been answered on the pages side and what remained was four
lines. Under the filing rule this repo just retired, that would have become a tenth open
issue.

### The non-mirror that was not safe

The tags fill seeds the resolve store *inside* its persist branch, so the tie-break loser
returned tags it had not seeded. That was left in place with a comment arguing the winner
would seed them.

The argument does not hold. `#tags` have no lazy-fetch fallback — unlike `[[links]]`,
whose `fetchAndCacheLinks` covers a miss — so an unseeded tag renders as a raw ULID. And
the winner is not guaranteed to seed: it can itself be rejected by a bus event landing
while it is in flight, which is the ordinary `sync:complete` window #4055 exists for. Then
nothing seeds them at all.

This was also a genuine asymmetry rather than a stylistic one: on the pages side
`populatePageResolveCache` runs *outside* the guard, over whatever is returned, so the
pages loser's rows were always seeded.

The seed is now gated on **servable** rather than on **persisting**. No cross-space write
is introduced, because `batchSet` keys on the live active space, which `spaceStillActive`
has just pinned.

## #4358 — the answer was documentation, and the premise was wrong

The issue asked whether seven `createPageInSpace` sites should register created pages with
the picker cache. Investigation overturned most of its framing:

- **Three of the seven paths had drifted**, and the enumeration **missed two sites** —
  including `paste-internalize.ts:110`, the closest analogue to `onCreatePage` in the
  codebase. The cause is that `createPageInSpace` has *two* entry points, a typed helper
  and the raw `commands.` binding: a reference query on the helper alone misses four
  sites, and on the binding alone misses five. There are **nine** sites outside
  `onCreatePage`; eight do not register, one does.
- **The eight cannot register.** `useBlockResolve()` has exactly one caller
  (`BlockTree.tsx:494`), and every site sits above or beside it — ancestors, sibling
  subtrees with no BlockTree at all, or module-level functions with no hook context by
  construction. This is not a line they forgot; it is a line they cannot write. The
  journal also mounts one BlockTree per day panel, so several caches coexist and there is
  no single cache to register into.
- **The journal site is the weakest case, not the strongest.** Date pages are ISO-named,
  so any query that could find one is at least three characters and routes to FTS, never
  the cache.
- **No #4319 overwrite is reproducible** from a site that never touches `pagesListRef`.

Recorded next to `registerCreatedPage` so the next person does not redo it, including one
asymmetry that is easy to miss: `searchPages` consults the cache only for ≤2-char queries,
but `appendCreatePageOptionIfNeeded` reads it at **any** length, so create-suppression is
affected more broadly than search is.

## Verification

170 tests in `use-block-resolve.test.ts`; 2716 across the wider block-tree/picker/hooks
suites; `tsc -b`, `oxlint` and `oxfmt --check` clean.

Every behaviour change here was falsified in both directions — the fix reverted must
redden the test, and for the two guard relaxations, the over-relax must redden the guards.
