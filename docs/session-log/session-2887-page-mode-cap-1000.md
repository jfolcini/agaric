# Session 2887 — page mode opens pages of up to 1000 blocks

#5691's budget at the cap is "INP and long frames no worse than block mode on the same page". #6083 and the shared grip (#6085) cut page mode's per-keystroke cost on WebKitGTK. With them, 1000 blocks is the largest measured size inside that budget, so `PAGE_MODE_BLOCK_CAP` goes from 500 to 1000.

**Measured** on WebKitGTK with `scripts/measure-page-mode-webkit.mjs`, 3 repeats, median [min–max], ms. The numbers are #6085's after-numbers:

| Blocks | Page INP | Block mode INP | Scroll long frames, page / block mode |
|---|---|---|---|
| 1000 | 40 [32–40] | 48 [40–56] | 1 / 336 |
| 2000 | 80 [72–80] | 48 [48–56] | 74 / 842 |

At 1000 blocks, page mode's INP is inside block mode's range, and it has far fewer long frames. At 2000 its INP is above block mode's, so the cap stops at 1000.

A keystroke still costs more in page mode than in block mode: 28 against 17 ms p50 at 1000 blocks. That cost is not in the budget, because INP is what a user feels and it stays within block mode's range.

Android WebView cannot be measured here, since the container has no KVM. Page mode is not offered on touch, so the cap is desktop-only.

**Changed:**
- the constant;
- the over-cap e2e spec, which seeds one block past the cap and reads the switch's reason;
- a perf-spec comment that named the old number.

The unit tests read the constant, so they move with it.

**Shown red:** with the cap at 2000, the over-cap spec's 1001-block page opens in page mode, and the spec fails waiting for block mode's rows.

**Suites:**
- vitest over `src/editor/page-mode`, `src/components/journal` and `src/components/pages`: 1978 passed;
- `e2e/page-mode-setting.spec.ts`: 4 passed.
