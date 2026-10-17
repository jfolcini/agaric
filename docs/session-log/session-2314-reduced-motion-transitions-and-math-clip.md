# Session 2314 — Reduced motion stops transitions; wide math scrolls while editing

Two rendering bugs found during #5678's investigation, plus a graph flake
with the same root cause.

**#5692.** Under reduced motion (the OS setting or Animations "Off"), Mermaid
flowcharts rendered several times too large; one grew from 378×1322 to
2094×4325.

- **Cause.** Both reduced-motion resets in `src/index.css` (the OS media
  query and `[data-motion='off']`) set `transition-duration: 0.01ms` on `*`
  and left `transition-property` at its default `all`. Every element without
  its own transition gained one on every property, for one frame. Mermaid
  measured its nodes mid-transition.
- **Same cause, graph.** graph-view's zoom tests caught the canvas and its
  labels drawn at the old zoom for a frame after each step. They flaked 7 in
  60 runs and reddened main once. Reduced-motion users saw that frame too.
  #5703 had fixed it with a graph-only rule; this global fix makes that rule
  redundant, so #5703 is closed and its regression test moves here.
- **Fix.** Both blocks set `transition: none`. At zero specificity, any
  transition a class declares still wins, and the token durations those use
  are already 0 under reduced motion.
- **Audit.** No code in `src/` listens for `transitionend`. Radix presence
  watches `animationend`, and sonner and cmdk use neither. The only listener
  is cytoscape's cache invalidation inside Mermaid's bundle, which is
  harmless.
- **Tests.** `e2e/diagram-reduced-motion.spec.ts` compares a flowchart's size
  with reduced motion on and off, for both triggers. It was off by 2,943 px
  before the fix, and reverting either CSS block reds only that block's
  test. The graph test, "under reduced motion a zoom step draws the canvas
  and its labels at the new zoom at once", passes with the global fix alone
  and reds without it (0.769 against 1).

**#5693.** In the editor at phone width, wide display math was clipped. The
math node view's `<button>` grew to fit the equation, so `KatexMath`'s
scroller (already `SCROLL_ONLY_WHEN_WIDER`) never overflowed, and the column
clipped it. Display math now makes the button `block w-full`, so the scroller
overflows when the equation is wider and shows no bar when it fits. A test at
390 px checks that the scroller overflows, ends on screen, moves on wheel, and
that a click still opens the source; without the fix it fails on "the
equation overflows its own scroller".

Gates: related vitest (15 files, 257), `npm run typecheck`, oxlint, oxfmt,
and Playwright under reduced motion (174 at `--repeat-each=3 --retries=0`,
including the diagram, math, dialog, sheet, menu and touch-menu specs), plus
the new and math specs without reduced motion (78) and the graph specs (66).
