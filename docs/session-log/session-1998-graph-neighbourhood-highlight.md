# Session 1998 — graph hover and focus highlight the neighbourhood

Set out to make graph hover and keyboard focus show a node's neighbourhood
without shifting its label (#5431).

Shipped: `patchGraphSelections` builds a neighbour map per topology; hover and
focus share one highlight that keeps the node, its 1-hop neighbours and the
edges touching it at full opacity and dims the rest. Hover wins over focus
while it lasts, and leaving it falls back to the focused node. Labels keep
their size and weight. One CSS rule eases opacity over `--duration-normal`,
which the reduced-motion and animations-off settings already scale to 0.

Decisions: an edge between two neighbours stays dimmed; only edges touching
the centre are highlighted. Label-by-importance belongs to #5430 and was not
built.

Traps: happy-dom evaluates neither media queries nor `var()`, so the
reduced-motion test reads the rule from `index.css` and checks its selector
and token, not the rendered duration. The fallback test was vacuous until it
asserted the hub dims when only focus remains. Suites run: full vitest,
typecheck, lint.
