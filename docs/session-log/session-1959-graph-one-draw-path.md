# Session 1959 — the graph draws through one path (#5427)

The graph's first render and its filter patches drew nodes and edges through
two copies of the same code: `renderGraphElements` with unkeyed draws, and a
patch path in `useGraphSimulation` with keyed joins, its own node sub-tree,
inline listeners and eleven mirrored constants. Every visual change in #5436
would have had to land twice.

What shipped:

- `patchGraphSelections` lives in `src/lib/graph-sim-helpers.ts` and is the
  only draw path: keyed joins for edges (`source->target`) and nodes
  (`d.id`); a node's child elements, role and cursor are created on enter
  only, so a patch never undoes the focus or hover styling of a node it
  keeps; the label, `<title>` and `aria-label` refresh on every patch.
- `renderGraphElements` and the hook's patch effect both call it; the
  mirrored constants, inline listeners and `truncateLabel` are gone from the
  hook (−207 lines).
- The hook test's d3 `join` mock now runs the enter callback as d3 does,
  instead of production code re-setting attributes for the mock's sake.
- Tests: first render and a filter patch produce identical markup after
  focus, hover, pointer, blur, End, click and Enter; each patch re-binds a
  kept node to the latest navigate without stacking listeners.

Verified: red with a different radius on one path, a different hover handler
on one path, focus styles skipped on the patch path, listeners stacking per
patch, and listeners bound only on the first render (all on copies, restored
and `cmp`-checked). The SVG after a patch, hover and focus was byte-identical
to before the change. Full vitest 20,804 passed; Playwright graph-view and
rename-invalidation 14/14; typecheck, oxlint and oxfmt clean.
