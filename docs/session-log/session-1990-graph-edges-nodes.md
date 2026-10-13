# Session 1990 — graph edges recede; node size and one accent carry the content (#5428, #5429)

Part of the #5436 graph cluster. Every node had the same radius and the
text colour, and edges were up to 6 px wide and scaled with zoom, so a real
vault rendered as a grey hairball with nothing standing out.

What shipped, on the single draw path from #5427:

- Edges: 1 px with `vector-effect="non-scaling-stroke"` (constant on screen
  at any zoom), opacity 0.2 plus 0.05 per extra reference (cap 0.45),
  colour `--graph-edge`.
- Nodes: radius `min(3 + 1.5·√degree, 12)`, degree counted from the edges on
  screen, so a filter that drops links shrinks the node; no new IPC. Hover
  and press radii, the label offset and the hit radius follow it.
- Accent: the active tab's page gets `--graph-accent` and
  `aria-current="page"`; switching page only re-marks nodes, without
  restarting the layout.
- Tokens in `src/index.css`: `--graph-node` (light and dark, with
  `prefers-contrast: more` values), `--graph-edge` (in dark, halfway toward
  the foreground so a faint edge stays visible), `--graph-accent` = brand.
  `theme-contrast.test.ts` checks node and accent at 3:1 in all six themes
  with and without high contrast.

Verified: 23 falsifications on copies (stroke, opacity, width, radius cap and
scale, degree counting, radius on patch, fill and `aria-current`, label
offset, hover and press radii, the accent effect and its hand-offs, token
values), all red, restored and `cmp`-checked. Graph and theme vitest 556
passed; full vitest 20,912 passed apart from the known `UnlinkedReferences`
race (3/3 alone); Playwright graph-view and theme-icons 20/20; before/after
screenshots (light, dark, 2.2× zoom, high contrast, hover, focus) compared.
Hover-highlighting edges (#5431) and label overlap (#5430) are next.
