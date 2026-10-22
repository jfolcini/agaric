# Session 2877 — the strip-scrollbars spec measures the filter row's own scroll area

`e2e/strip-scrollbars.spec.ts` failed on `main` after #6064 merged (CI runs 39832430424 and 39841445600, shard 4) with `locator.evaluate: Error: no scroll viewport`. It had passed on #6064's own head.

**Cause, as far as it was traced.** #6064 moved the spec's `navigateToView(page, 'Pages')` ahead of `setViewportSize(700)`, so the Pages view mounts at desktop width and turns narrow afterwards. `PageBrowserFilterRow` moves its row into a horizontal `ScrollArea` on the re-render that `useIsMobile()` flipping causes, and the spec read the row's nearest scroll viewport right after the resize. A local probe saw the row inside the page's scroll area before the resize and inside its own afterwards, never with none. The state CI hit, with no scroll area around the row at all, was not reproduced here.

The probe also showed the measurement was weak: with the narrow-screen wrap gone, the spec measured the page's vertical viewport and passed.

**Fix.** The filter row's `ScrollArea` carries `data-testid="page-browser-filter-scroll"`, and the spec measures that scroll area's viewport, as it already does for the recents strip. The locator waits until the narrow layout has drawn it.

**Shown red**, each mutation applied with a backup and restored on exit:
- the narrow-screen wrap removed: the locator times out, where before it passed;
- `SCROLL_ONLY_WHEN_WIDER` removed from the row's viewport: the filters entry reports `barHeight: 10`.

**Suites run:** the spec with `--repeat-each=3`, 3 passed; `npx vitest run src/components/PageBrowser`, 9 files, 265 tests.
