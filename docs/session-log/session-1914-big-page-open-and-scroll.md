# Session 1914 — opening and scrolling big pages (#5329, #5330, #5331)

The e2e perf run (#5299) showed that a 500-block page froze for 1.2 s on open
and stuttered on scroll. This batch fixes both and adds the two backend paths
behind them to the scheduled SLO bench.

## What shipped

- **#5329: open.** A tree renders its first 30 rows in full. Every row that
  mounts past them is a placeholder with an estimated height, and it hydrates
  when the viewport observer sees it. The focused row always renders in full.
  An e2e check that runs on every PR asserts that opening a 500-block page
  renders at most 60 rows in full.
- **#5330: scroll.** The observer queues rows that come into view and
  hydrates 4 per animation frame. The scroll-parent walk runs once per
  commit, not once per row that attaches.
- **#5331: backend.** `interactive_slo` now times `load_page_subtree` (a
  500-block page) and `list_pages_with_metadata` (the first page in the
  default sort) at 100K blocks. Each has a shape check before it is timed.
  Their budgets are 2× the worst local sample and are provisional until a
  `bench-slo` run measures them.
- **A bug the review found.** Clicking a heading in the page outline
  smooth-scrolled to the center. Every row it passed hydrated and grew past
  its estimate, so a heading far down a long page ended screens below the
  view. The outline now jumps the heading to the top. A new e2e spec covers
  it.

## Measured

`e2e/perf.spec.ts` on a 500-block page in Chromium at 1× CPU:

| Journey | Before | After |
|---|---|---|
| Open: worst frame | 1316 ms | 142 ms |
| Open: blocks rendered in full | 500 | 30 |
| Re-open: worst frame | 1185 ms | 217 ms |
| Scroll: long frames | 12 (676 ms) | 1 (58 ms) |

## Verified

- vitest across editor, hooks, pages and block-tree passed (236 files), and
  `npm run typecheck` is clean.
- Playwright passed for perf, page-outline, in-page-find, editor-lifecycle,
  deep-link, block-keyboard and block-dnd.
- Each new test was shown red against a scratch-backed mutation. The
  reviewer re-ran four of the hook mutations, and both directions of the
  outline spec.
- The SLO bench passed both new probes locally. Its budgets and shape checks
  were each shown to fail.
