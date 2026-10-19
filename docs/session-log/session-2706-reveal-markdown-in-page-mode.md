# Session 2706 — The Markdown reveal in page mode, and why no link marker showed

#5974 (sub-issue of #5691): with *Show Markdown syntax around the cursor* on,
page mode drew nothing, because `MarkdownReveal` was registered only in the
roving editor. Page mode now registers it too, and the reveal's own code did
not change.

**The link finding (block mode).** Nothing was broken at `50a2ac908`. With the
setting on, a markdown link with a label shows `[` and `](url)` while the caret
is in or touches the label: the unit tests (`markdown-reveal.test.ts`, the
links describe, built from `parse()`d Markdown), seven Playwright cases
(`e2e/markdown-reveal.spec.ts`, links and bare URL) and the real-backend
`markdown-reveal-persist.e2e.ts` (WebKitGTK) all passed. What shows nothing is
by design: a bare or autolinked URL (`writesBareUrl`: it is stored as it
reads), and a `[[page]]`, tag or block-ref chip. The likeliest reading of "no
link markers" is page mode, or a pasted URL. No block-mode fix was needed.

**Wiring is the ordering.** Among equal priorities TipTap runs the extension
registered last first, and `MarkdownReveal` (1001) must act before
`pageListKeys` (1001, Backspace takes the list style off) and `PageKeys` (1000,
the join). It is registered right after `pageListKeys`; a test goes red when it
is registered before. Page mode draws a list marker in the block's node view,
outside the text, so the widget `side` ordering of block mode does not apply
(`## 1. Title` cannot become `1. ## Title`); a test pins the DOM order.

**One new rule.** A selection that reaches into several `pageBlock`s reveals
nothing (`spansPageBlocks` in `revealed-markers.ts`): Ctrl+A would otherwise
walk the whole page for headings and runs. Its node name moved to
`page-mode/page-block-name.ts`, which `revealed-markers.ts` can import without
loading TipTap (`use-block-keyboard.ts` is on the cold-start path).

**Defined and tested, not built.** ArrowRight at a block's end steps out of the
mark (stored marks), the next ArrowRight is the editor's and leaves the block,
as in block mode; clicks, IME, undo through the page-wide history, chips and
the markers' DOM are unchanged code under the page's document, each with a
test.

**Measured (throwaway Playwright script, not committed; mock backend,
Chromium, 300 caret moves into another run per setting, three rounds, a shared
machine).** The plugin's own work, `state.apply`, is 0.4–0.5 ms median with the
setting on and 0.4 off at 500 blocks (`PAGE_MODE_BLOCK_CAP`): no whole-document
scan. The cost is ProseMirror's `view.updateState` plus the browser's
selection and layout once the markers change: median 8.5–9.0 ms on against
0.3 off at 500 blocks, 2.3 against 0.6 at 20 blocks and 3.2 at 100 (about
14 µs per block). `contain: layout` on the page blocks did not move it. A
caret move inside the same run costs nothing, as the decorations compare
equal. Under a frame at the cap; not mitigated.

**Tests, each shown red against the code it covers:**
- `page-mode-reveal.test.ts`: no registration (every test but one), registration
  before `pageListKeys` (the list-block Backspace test), no
  `spansPageBlocks` (the across-blocks test), its last-index `- 1` (the one-block
  Ctrl+A test); block mode treated as a page document, red in the existing
  `markdown-reveal.test.ts` heading test.
- `page-mode-reveal-lists.test.tsx`: the list marker appended after the text
  goes red on the DOM-order assertion.
- `e2e/page-mode-reveal.spec.ts`: red with no registration,
  without `spansPageBlocks`, and with `handleClick` returning false (the click
  test).
- `e2e-tauri/page-mode-reveal.e2e.ts`: green on the real backend; red with no
  registration (no markers drawn). It leaves the page and comes back and reads
  the stored blocks: still two, the second without the bold or a marker.
  `markdown-reveal-persist.e2e.ts` also passed there.
- No Stryker module covers `markdown-reveal.ts` or `revealed-markers.ts`.

**Not done:** the Android and touch passes (page mode is desktop only).
