# Session 1906 — five more stale-state audit findings

This continues sessions 1874 and 1885. It takes five more findings from the
stale-state audit: #5275, #5277, #5289, #5290 and #5292. Each had its own
builder and reviewer. Other sessions fixed the rest of the audit's list in
parallel while this ran (#5280, #5284, #5286, #5288, #5291, #5293, #5295
through #5298).

## What shipped

- **#5292: the Graph stayed stale after link-changing writes.** Import,
  template insert, and block-history restore and its Undo now record a
  graph change after a successful write. Quick capture (#5315) and
  Agent-access Undo already did, through `reloadChangedPageStores`.
- **#5289: chips kept rendering pages and tags that had left.** The resolve
  store's preload only merged what came back.
  - A full walk now re-resolves, in one batch, every cached entry it no
    longer names. That covers trashed, purged and moved-out pages and tags,
    a reverted create, and off-page `((block))` chips after a revert. It also
    makes the revert path's `refreshDeleted` redundant.
  - A targeted scan re-resolves the tags that dropped out of the tag list
    and any cached page the backend no longer returns.
  - Trashed rows strike through; purged and moved-out rows render broken.
  - Left: a page purged in a sync that also changed other pages waits for
    the next full walk.
- **#5277: renames made while another space was active didn't reach that
  space.** A space switch now retitles the incoming space's tabs and
  recents after its preload. `retitleHeldPages` moved to `page-rename.ts`.
- **#5275: link and tag counts kept counting the old space after a move.**
  - `inbound_link_count` and `tags_cache.usage_count` now count only
    sources and holders in the same space, using a NULL-safe `IS`.
  - A `space` property op enqueues `RebuildTagsCache` and
    `RebuildPagesCacheCounts`.
  - The review found that page, tag, journal and import creates dispatched
    their companion `space` op. That op had produced no task before, but
    would now have run two full-table rebuilds per create. A fresh block has
    nothing to re-scope, so those create sites no longer dispatch it.
  - Dedup holds `RebuildTagsCache` to the end of the batch, because boot's
    orphan-tag placement had rebuilt tags before the refs it unions.
- **#5290: a 5xx or 429 link preview was cached for up to 30 days.**
  `fetch_metadata` returns an error for them, as for network failures, so
  nothing is stored and the next hover asks again.

## Merging and rebasing

#5310 (session 1885) had gone stale against main twice while it waited.
#5309 and #5317 conflicted in `useSyncEvents.ts` and the HistoryView test.
#5309's space-list refresh also made the revert reload call `list_spaces`,
which the HistoryView tests had to stub. A merge in a separate worktree
resolved both while this batch's work stayed in the main tree. #5310 merged
as 58ab260.

This batch then rebased onto main. Quick capture already reloads through
`reloadChangedPageStores` (#5315), so #5292's extra call there was dropped.
The import runner keeps both main's property-cache invalidation and the
graph change. `pages-view.md` keeps both the #5286 and #5275 rows.

## Verified

- Each new test was shown red by reverting its fix in a scratch-backed copy,
  restored and checked with `cmp`. The reviewers re-ran those checks.
- Before the rebase:
  - `cargo nextest run --workspace` passed 6709 tests, twice (the #5275 and
    #5290 reviews).
  - `cargo clippy --workspace --all-targets -D warnings` was clean.
  - The per-item vitest runs were green.
- After the rebase: offline `cargo check`, the full nextest suite and the
  full vitest suite. The results are in the PR body.
