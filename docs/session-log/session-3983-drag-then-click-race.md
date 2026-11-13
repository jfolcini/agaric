# Session 3983 — a click right after a drag was being swallowed in specs

`e2e/page-link-drag.spec.ts` "a bookmark dropped on a block links the page at its end" failed on
PR CI with an empty `header-label` for fifteen seconds after clicking `Tags`. It was a lost click,
not a slow render. dnd-kit's sensors stop every click from the moment a drag starts until a 50 ms
timer after release (`AbstractPointerSensor.detach`). The spec's `dragTo` returned at mouse-up, so
the next click could land inside that window; the view stayed on the page editor, where
`useHeaderLabel` returns `''`.

The wait is now `dndClickGuardLifted(page)` in `e2e/helpers.ts`: a 50 ms timer started after the
release, so it fires after dnd-kit's. `dragTo` calls it, and so does `touchLongPress`, whose
hold-then-tap callers raced the same way. No assertion changed.

Decisions and traps:

- Latent since #6061, which gave `tab-reorder.spec.ts` this wait but not `page-link-drag`. Not a
  product bug: nobody clicks within 50 ms of a drop.
- To reproduce, stretch every 50 ms timer to 3 s from an init script: the old code failed eleven
  tests, the fixed code none. Stretching only dnd-kit's timer flags every spec that clicks soon
  after a drag.
- A lost click after a drag fails only when the next assertion depends on the view changing. In
  `bookmarked-pages.spec.ts` the `navigateToView` right after `dragBlock` can be swallowed and the
  test still passes, because it then reads only the sidebar. The mouse helper behind `dragBlock`
  was left alone; no caller went red.
- `tab-reorder.spec.ts` keeps its own copy of the wait.

Ran: the spec ten times under load, the nine spec files that use the changed helpers, and
`typecheck:e2e`. The whole Playwright lane is CI's run on this PR.
