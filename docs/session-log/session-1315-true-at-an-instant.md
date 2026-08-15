# Session 1315

## True at an instant

#3902: the pages-view spec reads the grid before the filter's re-render lands. The fix is
small. The interesting part is what the review could and could not confirm.

### The mechanism, confirmed

`usePageBrowserData`'s react-query key is `['pageBrowserData', currentSpaceId, sortOption,
wireFilters]`. Every `addPathFilter` / `addPropertyFilter` / `addBooleanFacet` helper
clicks Apply and returns without waiting. So each one triggers a real IPC round-trip
(`list_pages_with_metadata`) and, with `keepPreviousData`, the grid legitimately keeps
showing the **old** rows for a beat afterwards.

Reading it with `expect(visibleTitles(page)).resolves.toEqual([...])` right after is
structurally racy, because `.resolves` opts out of Playwright's auto-waiting entirely — it
takes one snapshot at the instant it is called. Same family as `evaluateAll` and
`allTextContents`. All twelve such sites in the file were converted to
`expect(locator).toHaveText([...])`, which retries; sites that genuinely wanted a subset
check rather than exact equality became `expect.poll(...)` barriers instead of being
force-converted, since array-form `toHaveText` would have been a *false* strengthening of
an assertion those tests never made.

### The number that did not reproduce

The build pass reported a 12/12 baseline failure rate. The review restored the pre-fix
file byte-for-byte and re-ran it: **12/12 passed**. It could not reproduce the failure at
all.

That is recorded rather than smoothed over. The issue itself documents this race as
machine-dependent — "reliably red on one machine, reliably green on another; CI shards all
passed on the same HEAD" — so a non-reproduction is weak evidence either way. What is
*not* in doubt is the mechanism above, which is visible in the source without needing to
observe a failure at all.

So the honest statement of what this change is: it removes a pattern that is provably
unable to wait, in a place where there is provably something to wait for. Not: it fixes a
flake measured at 12/12. The first claim is verifiable by reading; the second was not
reproducible on the machine that checked it.

Worth remembering when a flake fix is justified by a failure rate: a rate measured once,
on one machine, is a claim about that machine.

### Load average as a confounder

The full unit suite showed four timeouts during review, all in files this change cannot
load (vitest's `include` is `src/**`, the diff touches `e2e/`). Host load average was ~90
on a 16-core box, from concurrent worktree sessions. Timeout-class failures under that
contention are not evidence about the diff — but they are evidence that running several
full suites at once makes every timing signal in them worthless.

### #3897 needed no work

It was already fixed by #3888 (`268f4709d`), which landed the exact prescribed reordering:
resolve and assert the drop zone first, scroll today's section last, immediately before the
gesture. Re-measured on current `main` at 0 failures / 24 runs against the ~25% the issue
recorded. Closed with that evidence rather than re-fixed.

### Same defect class, one instance fixed here, one still live

The `sort` describe block in the same file has the identical pattern. It is **not**
untouched: `usePageBrowserSort` documents that `recently-modified`, `most-linked` and
`most-content` are **server-derived** sorts that round-trip via IPC, while `selectSort()`
waits only for the Radix listbox to close — and the "sort preference persists across
reload" test (now ~lines 541-575) used to capture a `before` baseline with exactly that
one-shot read, immediately after `selectSort(page, 'Most content')`, with no barrier
before the reload comparison. That case is fixed in this diff: instead of trusting the
one-shot `before` read (or a "stable across two reads" poll, which was tried and verified
to lock onto an intermediate `keepPreviousData` render that is itself stable-but-wrong),
the capture is now barriered against a hardcoded, independently-derived expected order
(`mostContentOrder`, re-derived from `compareMetaRows`'s count-DESC/id-ASC ordering over
the fixed seed ids and confirmed against `list_pages_with_metadata` directly). The reload
comparison then asserts against that known-good order rather than against whatever the
pre-reload one-shot read happened to catch.

What genuinely is still live is the *other* sort test, "the seven modes reorder the list"
(~line 486). It keeps four unbarriered one-shot `visibleTitles()` reads after
`selectSort` for the server-derived Most-linked / Most-content / Recently-modified modes
(~lines 491, 497, 503, 510). This was re-examined during the #3915 review, which found a
more precise problem than the one originally suspected: these assertions are weak enough
(`titles.slice(0, 2)`, `.length === 6`) that a stale, pre-round-trip read still satisfies
them. That makes the four reads **vacuous rather than flaky** — they don't sometimes fail
under timing pressure, they structurally can't fail regardless of whether the round-trip
they claim to check ever lands. That is a different, more precise claim than "filed rather
than trusted" above, and it is the one that's actually true of what remains. Tracked in
#3918 rather than fixed here.
