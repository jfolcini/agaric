# Session 2290 — No scrollbar on diagrams that fit; Mermaid styled to best practice

The maintainer: hovering over a Mermaid diagram (maybe images and math too)
showed scrollbars, and some Mermaid elements lacked borders or had opaque
fills. They asked for best practice, then for it to be implemented. Tracked
as #5677 and #5678.

**#5677, scrollbars.** Radix's ScrollArea always sets `overflow-x: scroll` on
its viewport, overflowing or not, expecting its own CSS to hide the native
bar. Our `index.css` turns native bars back on, so every diagram and display
equation reserved a 10 px scrollbar, even when nothing overflowed. A comment
there claimed Radix scrolls only on overflow; it is corrected. Images are not
in a scroll container and never had this. `SCROLL_ONLY_WHEN_WIDER`
(`overflow-x: auto` on the viewport) is used by the Mermaid and display-math
ScrollAreas. Wide content still scrolls. `e2e/diagram-scrollbar.spec.ts`
enables real scrollbars. Without the fix the bar is 10 px instead of 0, and
`hidden` instead of `auto` fails the "wide content still scrolls" check. The
hover-only flash itself could not be watched in WebKitGTK here; it follows
from the cause.

**#5678, Mermaid styling.** Rendered in light and dark for flowchart,
sequence, class, state, gantt and ER diagrams.
- **Already fine:** flowchart, state and ER node borders, flowchart edge
  labels, and clusters (canvas fill with a border).
- **Wrong before:**
  - class-diagram edge labels sat on opaque node-fill boxes, which Mermaid
    hard-codes;
  - notes were barely distinct from nodes;
  - in dark gantt, a heavy grey band, a done-task label at 1.32:1 and crit
    text at 3.52:1; in light gantt, the active task's border at 1.07:1;
  - ER zero-markers filled solid white in dark mode.
- **Now:**
  - notes take the pending-status tint;
  - gantt states take the done, active and error tints, each with its own
    border;
  - ER rows and section bands use the page and fill tokens, and gridlines the
    border token;
  - a small `themeCSS` puts edge labels on the canvas and makes ER markers
    hollow.

Across all six themes, text on fills measures 4.7–16.4:1 and borders
5.3–12.5:1. Gridlines are 1.2–1.4:1 on purpose; the axis labels carry the
information. `mermaid-theme.test.ts` pins each property, and six one-line
mutations each reddened their own test. `diagram-legibility.spec.ts` fails
with `themeCSS` emptied or node strokes removed.

**Found, filed, not fixed here:**
- under reduced motion, a Mermaid flowchart renders several times too large,
  because the global reset keeps `transition-property: all` at 0.01 ms and
  Mermaid measures mid-transition;
- wide display math is clipped when edited at phone width.

Gates: vitest (1,076 in 65 files), `npm run typecheck`, oxlint, oxfmt, and
the Playwright specs at `--repeat-each=3 --retries=0` (117 of 117).
