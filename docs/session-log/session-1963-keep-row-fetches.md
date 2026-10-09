# Session 1963 — rows in view keep the data they fetched (#5443)

The three fetches for the rows in view (`useBatchPropertyRows`,
`useBatchAttachments`, `use-block-link-resolve`) dropped their own answers
whenever the visible set changed: an in-flight request was marked stale and
its result discarded, so the same rows were asked for again. Scrolling a
300-block page sent 75–81 IPCs.

What shipped:

- A finished answer is kept for its ids even after the visible set moves on.
- Ids already in flight are not requested again.
- Properties and attachments: an invalidation (the provider's
  `invalidationKey`, which a space switch also changes) drops older answers
  and clears the in-flight set. Link resolve keys in-flight ids by space and
  drops an answer whose space changed while it was in flight.
- Loading stays on until every requested id is answered; it can't get stuck,
  since each request settles or is replaced by an invalidation's own.
- `e2e/scroll-ipc-counts.spec.ts`: opening a 300-row page sends exactly one
  of each call; after 12 wheel steps the totals stay at three or fewer.

Measured on the mock (300-row page, 12 wheel steps): open 2/2/2 → 1/1/1
calls; after scrolling 25–27 of each → 1/1/1 (the scroll sends none).

Verified: 17 falsifications on copies (in-flight filter, generation check,
in-flight clear on invalidation, loading cleared too early, space-switch drop,
in-flight release, bare-id keys, old code), all red; the e2e fails on the old
code at open (2 vs 1) and at the scroll limit (25 > 3). Full vitest 20,811
passed (one `UnlinkedReferences` load flake passes 3/3 alone); Playwright
35/35 across ten specs; typecheck, oxlint and oxfmt clean.
