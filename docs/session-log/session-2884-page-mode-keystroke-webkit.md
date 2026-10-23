# Session 2884 — a page-mode keystroke no longer lays out every block on WebKit

#5691's item "No per-keystroke work that grows with the page". On WebKitGTK, the desktop runtime on Linux, a keystroke in page mode cost more the longer the page was, while block mode's cost stayed flat.

**Cause: one CSS rule, not script.**
- **The JS is small.** A Chromium profile put page mode's JS at about 5–7 ms per key, mostly ProseMirror's `readDOMChange`, `dispatch` and plugin updates. It grew by only about 2 ms from 250 to 2000 blocks.
- **WebKit spends the time natively.** Most of a key went to WebKit's own text insertion, from keydown to `input`; `view.dispatch` took only a few ms of it.
- **A clone with no JS costs the same.** Page mode's DOM cloned into a plain contenteditable, with no ProseMirror and no JS, cost the same per key. Removing page mode's CSS from the clone took most of it away.
- **Bisecting the CSS named `display: flow-root`** on every `[data-page-block]`. #5825 had added it to keep a list marker's float inside its block, and measured it only on Chromium. WebKit re-lays out every block that is its own formatting context on each key. `contain: layout` has the same cost.

**Fix (`src/index.css`).**
- Blocks are no longer formatting contexts. A `::after { clear: both }` clearfix keeps the marker's float inside its block.
- Query and embed blocks keep `flow-root` while the caret is outside them. That is the only state in which they have no vertical padding, so without it their content's margins would collapse out.

**Harness.** `scripts/measure-page-mode-webkit.mjs` compares page mode with block mode on WebKitGTK: MiniBrowser through WebKitWebDriver, against the built `dist/` and the mock. Review fixed two defects in it:
- it measured whatever already served its port;
- it left `vite preview` running after every run, because it spawned `npx` and `kill()` stopped only npx.

It now runs `node_modules/.bin/vite` directly and waits for that preview's own `Local:` line.

**Measured** with that harness, 3 repeats, median [min–max]. "Before" puts main's two rules back through the harness's `page+css` config in the same run.

| Blocks | Page key p50, before | Page key p50, after | Block mode key p50 |
|---|---|---|---|
| 500 | 30 [26–36] | 29 [24–31] | 14 [12–14] |
| 1000 | 49 [49–50] | 38 [37–44] | 13 [12–13] |
| 2000 | 125 [122–127] | 68 [68–73] | 13 [12–14] |

Times are in ms. INP at 2000 went from 168 to 96 ms. Open times and scroll long frames did not change. On Chromium, a page of list styles at 1000 blocks costs about 3 ms more per key; WebKitGTK and WKWebView gain far more.

**The cap stays at 500.** Page mode still adds about 3.5 ms per key for every 100 blocks. From 1000 blocks its INP is above block mode's. The largest remaining cost is the opacity-0 grip button on every block: hiding all gutters takes 1000 blocks from 39–42 to 27–30 ms. A shared grip is the next PR.

**Layout parity on WebKitGTK (review).** 360 element boxes on a seeded page were compared with main's CSS against this CSS. The page covered headings, a heading bullet, wrapping, empty and nested bullets, code, tasks with chips, a query, an embed, a quote and a final paragraph. The caret was outside and inside six kinds of block, at 1280 and 420 px. 0 boxes moved in 14 runs. Removing the clearfix moved 271–316 boxes, and dropping `flow-root` from closed query and embed blocks moved 10–69.

**Shown red,** each with a one-command mutation that restored the file:
- `flow-root` restored on blocks: the new test's `display` assertion fails;
- the clearfix removed: the marker overflows its block's content box;
- `flow-root` removed from rendered blocks: the existing query/embed geometry test fails.

**Suites:**
- vitest over `src/editor`, `src/components/block-tree` and `src/__tests__`: 160 files, 5224 passed;
- typecheck, lint and the import-cycle check;
- Playwright: every `e2e/page-mode*` spec plus the strip-scrollbars, callout and list-style specs, 91 passed.

`src/index.css` selects the whole Playwright lane and the whole e2e-tauri lane; CI is the check for those.
