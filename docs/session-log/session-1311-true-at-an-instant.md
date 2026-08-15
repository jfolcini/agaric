# Session 1311

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

### Same defect class, still live

The `sort` describe block in the same file has the identical pattern and is untouched
here: `usePageBrowserSort` documents that `recently-modified`, `most-linked` and
`most-content` are **server-derived** sorts that round-trip via IPC, while `selectSort()`
waits only for the Radix listbox to close. Line 523 is the sharpest case — it captures a
`before` baseline with no barrier, then compares it post-reload with a retrying assertion,
which would simply retry against a wrong expected value and time out.

It passed 15/15 when checked, which is exactly the amount of reassurance the paragraph
above says not to take. Filed rather than trusted.
