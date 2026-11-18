# Session 4336: area slice 3, the Pages list, on the real backend

#6926 slice 3 (#6529).

**Promoted to `REAL_BACKEND_SPECS`:** `pages-view`, `pages-reopen`, `pages-browser-happy-paths`, `new-page-dialog`, `bookmarked-pages`, `page-kebab`, and the new `pages-list-local-write`.

**pages-reopen's "6 list calls vs 3":** it failed 4 runs in 8 on the bridge at three workers. It is not a double fetch.
- On every failing run, the extra calls are one refetch of the three loaded pages, set off by a `blocks:changed` that arrives after the view opened.
- The change feed sends one event per seed write, then one naming all 120 seeded pages about 2.4 s after the last write. That last one waits for the #2935 lifecycle-rebuild debounce: `change_feed::take_settled` holds pending changes while a rebuild is armed. A list read before then is stale, so the refetch is right.
- The test's precondition, that nothing is pending, did not hold yet when it navigated.

**Fix: a backend-condition wait.**
- The bridge gets a `settle` op. It answers once the change feed has sent every commit recorded so far, which the new `ChangeFeed::is_idle` reports.
- The feed now marks changes as in flight from the take until `emitted()`. The mark, `emitted()` and `is_idle()` compile only under `test-util`, so production carries none of them. Without that mark, `settle` could answer while the app crate still resolves the event's pages, before it emits.
- `settleBackend(page)` in `e2e/helpers.ts` calls it, through `window.__settleBackend`. On the mock that waits one task, when its feed fires. `seedBulkPages` and `seedFacetPage` call it.
- Under the load that failed 4 runs in 8, the test passes 12 of 12.
- Two waits I tried did not work:
  - A wait for "an event naming the last page" went to 7 failures in 12, since that page's id is in an early event.
  - A separate check that no lifecycle rebuild is armed never fired: while one is armed the feed's pending set is not empty. It is not in the fix.

**pages-view:**
- "Last-edited buckets" is `@mock-only`: its "long ago" bucket needs pages edited months back, which only the mock's seed has.
- The six-sort test's "Last edited" step assumed the mock seed's shared backdated stamp. It now edits a Projects block and expects Projects first, which holds on both backends.

**Ported from WebdriverIO, then deleted there:**
- `pages-most-linked` is now a `pages-view` test: two new pages linking Target put it first under "Most linked", with count 2, and Rival's row shows 1. Seed pages tie Rival's count, so only its count is pinned.
- `pages-list-local-write` is now `e2e/pages-list-local-write.spec.ts`.
  - It ran with a slow materializer on the premise that only a background rebuild fills `pages_cache`. That premise no longer holds: a new page's row is written in the create's own transaction (the page-create INSERT in `apply::pages_cache`).
  - Neither skipping the feed's settle nor its lifecycle wait turns it red. What it pins is that the feed sends an event for a local command at all.
  - It runs at normal speed, and its entry in `SPECS_WITH_A_SLOW_MATERIALIZER` is gone.

**Shown red:**
- `settle_answers_once_the_change_feed_has_sent_everything` fails if `settle` answers at once.
- `taken_changes_keep_the_feed_busy_until_emitted` fails if a take does not set the in-flight mark.
- On the bridge, the Most-linked test fails when the sort reads `child_block_count`, and the local-write test fails when the feed does not emit. On the mock, both fail when their mock counterpart is broken.

**Ran:**
- Bridge: the seven specs at three workers, twice, 74 of 74 each.
- Mock: the same plus the other pages specs, 102 of 102.
- The tauri-mock vitest suite (2162), `cargo clippy --workspace --all-targets` and typecheck are clean.
