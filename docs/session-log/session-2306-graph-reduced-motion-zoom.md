# Session 2306 — Under reduced motion, a graph zoom draws at the new zoom at once

Main's Playwright went red on graph-view's "edges stay a 1 px hairline on
screen as the view zooms in". Its sibling, "a label is the same height on
screen at three zoom levels", failed 4 of 12 runs locally. Both read the
drawn scale after a zoom. Retries are off (#5657), so this reddened PRs at
random.

**Cause, an app bug.** The reduced-motion block in `src/index.css` sets
`transition-duration: 0.01ms` on `*` and never sets `transition-property`,
which defaults to `all`. Under reduced motion, every element without its own
transition gets one on every property. On the graph canvas that includes the
root `<g>`'s `transform` and the font size `scaleLabels` sets on the nodes
layer, which each label inherits. So for one frame after every zoom step the
canvas and its labels are drawn at the old zoom, while the attributes already
hold the new one. That stale frame is what the tests caught: a drawn
`matrix(2.6…)` under an attribute of `scale(3.38)`.

#5666, merged tonight, did not cause it: with the graph files from before it,
4 of 40 runs still failed. #5656 exposed it by moving these tests under
`reducedMotion: 'reduce'`.

**Fix.** The graph `<svg>` has a `graph-canvas` class, and
`.graph-canvas * { transition-property: none; }`. The highlight's opacity fade
is more specific and still applies. A new test, "under reduced motion a zoom
step draws the canvas and its labels at the new zoom at once", compares the
drawn transform and label size with the values just written, in the same
frame. It fails every time without the rule.

The same blanket rule gives one-frame transitions to every element in the
app; #5692 found Mermaid diagrams measured mid-transition from it. The fix
here stays local; the global rule belongs to #5692.

Failure rate for the two tests at `--repeat-each=30 --workers=4`: 7 of 60
before, 0 of 60 after. graph-view and graph-restore at `--repeat-each=5`:
120/120.

Gates: graph vitest (22 files, 419), `npm run typecheck`, oxlint, oxfmt.
