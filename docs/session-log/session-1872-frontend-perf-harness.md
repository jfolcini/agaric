# Session 1872 — measuring where the app is slow

The maintainer reported that the app feels slow and asked for metrics, logs and
traces from the e2e lane, with Lighthouse as a candidate tool.

## Approach

- **Lighthouse does not fit.** It scores page loads over a network, while the
  slowness here is in-app interaction on a local bundle. Playwright already
  drives Chromium, and CDP plus the Long Animation Frames and Event Timing APIs
  give the same signals per interaction, with script attribution.
- **The mock had to stop distorting the numbers.** At 500 pages,
  `list_pages_with_metadata` took 3.1 s per call in the mock, because
  `rawOpLogLastEditedAt` JSON-parsed the whole op log once per page.
  - It now keeps a block → last-edited index, rebuilt when the op log changes.
    The handler's per-page descendant filter is one pass instead of one per page.
  - All 1100 mock tests pass. With the cache never invalidated, 17 of them fail.
- **Mock work moved out of the interactions.** The mock runs in-page, so its
  handlers landed inside the interaction that called them and inflated INP.
  The perf run defers each handler to its own task and reports it as `mockMs`.

## Findings

All runs used a vault of 500 pages × 20 blocks plus one 500-block page. The
browser was headless Chromium 141 on a 4-core container.

- **Opening a page renders every block, then discards most of them.**
  - `useViewportObserver` treats an unmeasured block as on-screen, so the first
    commit renders all 500 blocks in full. That peaks at 12.8K DOM nodes.
  - The observer then swaps all but 22 of them for placeholders, leaving 1.4K
    nodes.
  - Cost of the first open: one frame of 1.2 s and 1.8–2.0 s of long frames at
    1× CPU. Re-opening the page costs 0.95–1.2 s.
  - At 4× CPU throttle the worst frame is 6.9 s.
  - Inside that render, `scrollParentY` (one `getComputedStyle` walk per row
    attach) costs about 110 ms. GC costs 200–350 ms.
- **Scrolling hydrates rows in 70–140 ms bursts.** Each `IntersectionObserver`
  callback renders a batch of full blocks: 11–15 long frames per 20 wheel ticks
  at 1×, and 1.3 s of long frames per burst at 4×.
- **Interaction latency is fine at 1×.**
  - INP was 32 ms for typing, 112 ms for click-to-edit, and about 190 ms for
    Enter-to-new-block.
  - At 4× CPU, click-to-edit, Enter and arrow navigation reach 400–1100 ms.
- **Each Enter in a block containing a `[[link]]` refetches three queries.**
  - It bumps the graph-structure counter, which refetches
    `list_pages_with_metadata` (`PagesTreeSection`), `list_backlinks_grouped`
    and `list_unlinked_references`.
  - Whether that costs much depends on real backend time, which this lane
    cannot see.
- **Boot is fine on desktop.** FCP was 350 ms and LCP 780 ms at 1×; at 4× they
  were 1.1 s and 3.0 s. The main chunk is 953 KB minified.
- **The backend is within its budgets at 100K blocks.** The latest
  `bench-slo` run passes every interactive budget. The slowest commands are
  `list_page_links` at 94 ms and `count_backlinks_batch` at 63 ms.
  - `load_page_subtree` and the default `list_pages_with_metadata` sort are not
    in the bench.
- **Long frames with no script in them are paint.** A trace of the palette
  opening shows `SoftwareRenderer::DoDrawQuad` at 116 ms, because headless
  Chromium rasterizes in software. Such frames are not counted as findings.

## Shipped

- `e2e/perf.spec.ts` (opt-in, `AGARIC_PERF=1`) runs the journeys above. It
  reports INP, long frames net of mock time, peak blocks and DOM nodes, React
  commits, CDP script and layout time, and CPU per bundle chunk. CPU throttle
  and per-journey Chrome traces are optional.
- The mock fix described above.
- A section in `e2e/AGENTS.md`.

## Verified

- `npx vitest run src/lib/tauri-mock`: 53 files, 1100 tests pass.
- The perf spec passes at 1× (500 pages) and at 4× with traces (60 pages), and
  is skipped without `AGARIC_PERF`.
- `npm run typecheck:e2e` and oxlint on the spec pass.
- The local runs launched the container's preinstalled Chromium through a
  throwaway config, because the pinned Playwright browser is not installed
  here.
