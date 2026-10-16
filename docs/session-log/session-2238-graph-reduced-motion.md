# Session 2238 — Reduced motion stops animating the graph, and faster graph specs

A CI survey timed the graph Playwright specs at 7 to 12 s each.

**A reduced-motion bug.** On the worker path, the reduced-motion cap of 300
ticks never took effect. The main thread applied every worker tick as it
arrived, and the worker throttles ticks to one per 16 ms, so a
`prefers-reduced-motion: reduce` user watched about 5 s of the graph
settling. The main-thread path lays the graph out in one synchronous pass.
Now the worker does the same: `WorkerStartMessage` carries `reducedMotion`,
and with it set, start, update and resize run the ticks at once and post a
single `done`. `REDUCED_MOTION_TICK_LIMIT` moved to `graph-forces.ts`, which
both paths share. A new vitest drives the real d3-force worker. It was red
first (`expected [] to deeply equal [ 'done' ]`) and checks that the layout
equals the main-thread one.

**Open question:** the main-thread reference sets `alphaDecay(1)`, which
cancels the link and charge forces after the first tick. Reduced-motion users
therefore get a looser layout than everyone else. This change matches that
reference, as asked.

**Faster specs.**
- The zoom, wheel, pan, hairline and label-height tests emulate reduced
  motion, so the layout is at rest when they start. None of them depends on
  the animated settle.
- `fittedTransform` polls every 100 ms, not 500 ms. `settledPositions` polls
  every 250 ms, not 1000 ms, and now also waits for the zoom transform to
  stop changing. The faster poll exposed a race in which positions were read
  during the fit's 300 ms ease: 2 of 20 runs failed before, 40 of 40 passed
  after.
- One worker, two runs: the zoom, wheel, pan, hairline and label tests went
  from 6–9 s to 1–2 s. Both specs together went from about 1.8 min to
  1.0 min. `graph-view` passed 210 of 210 repeat runs.
