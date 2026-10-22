# Session 2851 — the Markdown reveal shows quote, callout, code-fence and math syntax

This covers #5691's Obsidian parity item for block-level syntax reveal. The existing reveal plugin (`markdown-reveal.ts`) now also draws, around the caret, the stored syntax of block constructs. It works in block mode and in page mode.

- **Quotes and callouts.** Each line the selection touches starts with its `> ` run (`> > ` when nested). A callout's first line shows `> [!TYPE] `.
- **Code blocks.** The opening fence (with the language) and the closing fence are drawn as lines above and below the code box, at the stored fence length (the serializer's `codeFence`, now exported). A node decoration on the `<pre>` carries them as attributes, and its `::before` and `::after` draw them (`.md-reveal-block-syntax` in `index.css`), with empty alt text so screen readers skip them. Drawn as widgets, they were text in the editor: inside `<pre>` Chromium typed after a highlighted keyword at the code's start (the `toolbar-and-blocks` spec caught it), and around it WebKitGTK's WebDriver read the fences back as the block's text, so the real-backend lane's read-back check wiped the fresh code block and retyped into a paragraph.
- **Math.** `$` sits beside the caret for inline math, and `$$` above and below a selected display equation, drawn as the fences are. The LaTeX stays rendered.

The markers are read-only, like chip syntax. The editor's own keys behave as with the setting off; Backspace at a quote's start still lifts the line out. The quote and `$` markers are `aria-hidden` and skipped by Find; all of them are frozen during IME composition and while the mouse button is down, as before. Only the selection's own lines and the atoms beside it are read, so there is no document scan.

A separate review found one defect. A range selection revealed only the lines at its two ends, so the middle lines of a selected callout looked unquoted. It now walks the lines the range covers, as headings and inline marks already did. The reviewer also confirmed by screenshot that the caret is visible in an empty code block in both modes.

`turn-into-chord.spec.ts` now expects the quote's `> ` in the editor, since the reveal is on by default. Its reopen check still reads the stored text.

Shown red:
- the opening syntax drawn after the caret;
- the callout type dropped, or on every line;
- a fixed three-backtick fence;
- no display math;
- `$` beside any node;
- the preference ignored;
- the page-mode cross-block guard removed;
- the IME freeze removed;
- markers not drawn;
- fences inside the code;
- `aria-hidden` dropped;
- the range walk reduced to the two ends;
- on Playwright: markers not drawn, the caret placement, fences inside the code, and the stored fence.
- the fences drawn as widgets again: the editor's text then holds them, in vitest and on Playwright in both modes; a WebKitGTK WebDriver probe of the real-backend flow lost the code block with them and kept both lines without them.

Suites run:
- vitest over `src/editor` and `src/__tests__` (3852 tests);
- typecheck, lint, and `prek` (including the manual stage);
- 242 Playwright tests over the reveal, page mode, toolbar, callout, math, Mermaid, slash and turn-into specs.

Left as is: highlight.js's keyword colour fails axe contrast (4.13:1) in every editor code block. That predates this change, and the new spec excludes `.hljs-*` from its axe run; it is a follow-up item.
