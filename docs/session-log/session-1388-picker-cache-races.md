# Session 1388 — picker cache races and the untitled-page search gap (2026-08-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-23 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#4270`, `#4152` |
| **Items modified** | `#4275` (items 1 and 4 fixed; item 2 decided and documented; item 3 deliberately not built) |

**Summary:** Closed the two remaining ordering holes in the `[[` / `#` picker's resolve
cache and restored the ability to find a NULL-content page by typing its displayed label.
A create landing mid-fill was silently lost because `onCreatePage`/`onCreateTag` never bumped
the #4055 generation counter; two overlapping fills resolved last-resolved-wins rather than
latest-issued-wins. Both are now closed by guards that compose rather than replace each other.

The #4152 fix itself then took three rounds to land correctly (PR #4295 and its review): the
first pass matched a NULL-content row's displayed "Untitled" placeholder by folded SUBSTRING,
which also matched every one of "Untitled"'s own substrings ("unt", "tit", "title", ...) — and
because blank titles sort first (#4138), a run of them could consume an entire result budget
and drop a genuine match. Round two narrowed the match to a folded PREFIX test on the FTS
path's cache supplement, and shared that test (`matchesPageRowFolded`) with the short-query
`matchSorter` path too, on the initial claim that `matchSorter`'s own ranking bounded the
crowd-out there. Round three found that claim wrong — a prefix query ranks a blank row's
"Untitled" hit at the SAME tier a genuine title match gets, not a fixed low one — and gave the
`matchSorter` path the same real-content-first partition: real matches rank first
unconditionally, blank rows only fill the slots real matches don't use. A follow-up review
found the FTS path's OWN cache supplement had never received that partition (its
`.slice(0, 10)` was still a flat, pagesListRef-ordered — i.e. blanks-first — filter, so a
prefix query like `unt` reproduced the exact crowd-out on that path), and that
`matchesPageRowFolded` recomputed the folded placeholder from scratch for every blank row on
every keystroke; both are fixed here, the second by hoisting the fold to once per
`searchPages` call (recomputed each call, not cached at module scope, since the active locale
can change at runtime without a remount).

**Files touched (this session):**
- `src/components/block-tree/use-block-resolve.ts`
- `src/components/block-tree/__tests__/use-block-resolve.test.ts`
- `docs/session-log/session-1388-picker-cache-races.md` (this log)

**What changed, per issue:**

- **#4275 item 1** — `onCreatePage` and `onCreateTag` now bump `nameChangeGenerationRef`
  after the create commits. The #4008 append-only-if-filled guard means the append is
  skipped while the ref is empty, so before this fix a racing fill's *pre-create* snapshot
  landed last and won, and the new page or tag stayed absent until something else
  invalidated. Bumping makes that snapshot fail the existing generation guard, and the next
  read re-fetches with the create included.
- **#4275 item 2** — decision recorded rather than changed: the generation counter stays
  **global** across entity and kind. Over-rejection is the correct bias for a correctness
  guard (it can never under-reject), and two counters are two things to keep in sync for a
  cost that is one round trip and self-heals on the next keystroke. The reasoning now lives
  in a comment above the ref's declaration so the next reader does not re-derive it.
- **#4275 item 3** — deliberately not built. The issue itself says backoff under sustained
  invalidation is worth measuring before designing for, and no measurement of real sync
  fan-out exists yet. Left open on the issue.
- **#4275 item 4** — the rejection-fallback comment now describes the space-switch case as
  well as the invalidation case, and states why it is safe: the resolve-store writeback stays
  gated on `requestSpaceId`, so no cross-space write is reachable through that path.
- **#4270** — added per-list monotonic request sequence refs captured synchronously at
  dispatch and ANDed into the existing write guard, so the latest *issued* request wins
  regardless of resolve order. The test that previously *documented* last-resolved-wins was
  inverted to assert the corrected behaviour.
- **#4152** — the localised `untitledOr()` placeholder is matched at **filter** time in both
  search paths, not at seed time: the stored title and therefore the sort key stay raw, which
  was the point of #4150. A NULL-content row's match text is decided by one shared helper,
  `matchesPageRowFolded` — a fold-aware PREFIX test against the placeholder for a blank row,
  the ordinary folded-SUBSTRING test (`matchesSearchFolded`) for a row with real content — so
  the two search paths can't diverge on what counts as a hit. Both paths also partition their
  result budget the same way: real-content matches are ranked/filtered first unconditionally,
  and blank rows are only admitted into the slots real matches don't use — `searchPagesViaCache`
  via a `matchSorter`-then-blanks concatenation, `searchPagesViaFts`'s cache supplement via the
  same real-then-blank split before its `.slice(0, 10)`. `matchesPageRowFolded`'s per-blank-row
  fold of the placeholder is hoisted to `foldedUntitledPlaceholder()`, computed once per
  `searchPages` call rather than once per blank row per keystroke; it is recomputed on every
  call rather than cached at module scope, because the active locale can change at runtime
  (`i18next.changeLanguage`) with no remount in between. `searchPagesViaCache`'s `matchSorter`
  `keys` option is back to the plain `'title'` string form now that the placeholder no longer
  needs to be in the ranking key.

**Verification:**
- `npx vitest run src/components/block-tree` — all tests pass, including a new regression
  test for the FTS-path prefix-query crowd-out (confirmed RED against the pre-fix code first).
- `npx tsc -b` — clean.
- `npx oxlint src/components/block-tree/` — clean.
- Every new test demonstrated RED against the reverted production change before being
  accepted, and the reverts were restored.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** One of five parallel streams in an overnight batch run; sessions 1388–1392
are siblings of the same run, each holding a distinct number per the numbering window.

**Commit plan:** single commit / pushed.
