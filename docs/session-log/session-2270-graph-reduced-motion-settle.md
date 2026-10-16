# Session 2270 — The reduced-motion graph settles instead of freezing

The maintainer left it to this session whether the reduced-motion layout
should keep `alphaDecay(1)`. It should not.

**Cause.** Every reduced-motion path set `alphaDecay(1)` before ticking
`REDUCED_MOTION_TICK_LIMIT` times synchronously: mount, update and resize on
the main thread, and the worker's `start`. d3-force decays alpha before it
applies the forces, so alpha was already 0 on the first tick. Link, charge
and gravity never acted. Collide and center do not scale by alpha, so nodes
did not overlap, but links stayed at 32–40 px against a rest length of 60,
and a page added by an update stayed where d3 seeded it, 519 px from its hub.
Each tick still computed every force, so the setting saved nothing.

**Fix.** The paths tick with d3's default decay, which brings alpha from 1 to
`alphaMin` in exactly `REDUCED_MOTION_TICK_LIMIT` ticks; from 0.3 (update,
resize) it needs fewer. Dropping it broke drag release, which had relied on
the leftover decay, so drag now follows the reduced-motion rule as well:
- while a node is held, only that node follows the pointer, drawn once per
  move;
- release settles once from where it was let go;
- a click with no movement changes nothing.

The builder's first version coasted for about four seconds after a release.
The second re-settled on every click. Review then found that the main thread
did not draw the held node during a drag, and that the worker animated the
neighbours. All four were fixed before merge.

**Tests.** `src/lib/__tests__/graph-reduced-motion.test.ts` drives real
d3-force on both paths. It checks that links end within 5 px of the link
distance (charge and collision stretch a settled link slightly) at mount,
after an update and after a resize. It checks that a drag moves only the held
node and settles once on release, and that a click applies and posts nothing.
Putting `alphaDecay(1)` back reds each path. So does a click that settles, and
so does the earlier restart-on-move.

Not changed: a drag release on the main-thread fallback (no Worker) does not
call `onSettled`, so labels are not re-placed there. Update and resize had
the same gap before.

Gates: graph vitest, `npm run typecheck`, `npm run lint`, and the graph-view
and graph-restore Playwright specs at `--retries=0`.
