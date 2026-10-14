# Session 2028 — Graph: degree-aware forces and fit to view

Set out to work #5432: every node repelled, collided and linked the same, so hubs crowded and unlinked pages drifted to the rim, and Reset zoom returned to the identity transform instead of the graph.

What shipped: `applyGraphForces` reads each node's `degree`. Repulsion is `−(60 + 40·√degree)` with a `distanceMax` of 180, so a hub clears room for its neighbours and separate clusters stop pushing each other out; collision is the drawn radius plus 10. `nodeRadius` moved into `src/lib/graph-forces.ts` so the force and the renderer share it. Degree is stamped on the nodes and travels in the worker `start` / `update` payload, and the worker/main-thread parity tests cover it. `fitTransform` frames the nodes' bounding box with 64 px padding and caps the scale at 2. A fresh layout is fitted once on its first settle, the worker's reduced-motion tick limit included; a layout restored with its viewport (#5434) is not. Reset is now *Fit to view* (button and `0`). Main-thread drag uses `alphaTarget` like the worker path.

Traps: the fit changes the starting zoom, so the Playwright zoom, pan and edge-width tests wait for the fitted transform and assert relative to it; the 1 px edge test zooms in twice instead of three times because a small fitted graph already sits at the scale cap. Left as the issue asks: a zoom made before the first settle is replaced by the fit.

Ran: vitest over the graph hooks, workers, lib and components, `npm run typecheck`, oxlint, oxfmt, and `e2e/graph-view.spec.ts` and `e2e/graph-restore.spec.ts`.
