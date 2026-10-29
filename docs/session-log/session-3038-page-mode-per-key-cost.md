# Session 3038 — A keystroke in page mode lays out only the block it changed

#5691's per-key budget item: the cost of one keystroke in page mode grew with the page.

**Found by profiling** 31 keys typed at block 3 of a 2,000-block page in Chromium:
- **`page-lists`' `layout`** walked every block on every transaction: 0.59 ms per key.
- **`leftTheirList`**, in the same file, did the same: 0.23 ms per key.
- **The task controls gate's IntersectionObserver** watched all 1,990 waiting blocks: 1.26 ms per key in `computeIntersections`.

Against a key-to-paint p50 of about 23 ms in that run, those are small shares. Most of the rest is the browser laying out the whole contenteditable, and ProseMirror's view update. Both are still open.

**Changed:**
- **`differsInside(before, doc)`** uses ProseMirror's `findDiffStart`/`findDiffEnd` to tell whether exactly one block's content changed.
  - Any change to a block's type, attributes or marks, a split, a join, or a move falls through to the full walk, which stays as the fallback and the test oracle.
  - On the fast path, `layout` recomputes only that block's marker flag. Numbering is still recomputed over all items, so a sibling's number follows.
  - `leftTheirList` checks only that block.
- **The controls gate** observes only the waiting blocks within two screens of the viewport. It picks them by binary search and re-picks on scroll, on a resize of the editor or the scroller, and when a block is drawn anew. It tears all of that down when the editor is destroyed.
- **`e2e/perf.spec.ts`** opens the journal in block mode before each run, because the journal now opens in page mode and the block-mode leg waited for block-mode rows.

**Measured** with `e2e/perf.spec.ts`, as median [min–max] of three runs, page-mode key-to-paint:

| Engine | Size | Before | After |
|---|---|---|---|
| Chromium | 2,000 blocks | 32 [27–35] ms | 23 [20–23] ms |
| Chromium | 5,000 blocks | 60 [59–65] ms | 50 [49–57] ms |
| WebKitGTK | 2,000 blocks | 43 [43–46] ms | 41 [41–41] ms |

- Chromium p95 and INP overlap before and after.
- The WebKitGTK "after" run had a lighter load, so read 43 → 41 as marginal. 500 and 1,000 blocks did not change.
- The box is shared, so these are directions, not sizes.

**Tests:**
- A per-key count: 2 derivations per key at 1,000 blocks, against 2,000 before.
- A property comparing the incremental layout and `leftTheirList` with a full walk. The review added id, mark, join and move changes, and a leaving-the-list property; it caught a mutant the count test missed.
- Six gate tests.
- Each new test was shown red.
- The existing long-page e2e ("controls as it nears the view") goes red when the scroll re-pick is removed.
