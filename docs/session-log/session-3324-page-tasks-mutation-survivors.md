# Session 3324 — page-tasks mutation survivors

The weekly sweep left 24 survivors in `src/editor/page-mode/page-tasks.ts`
(#5964), the page-mode node view and the gate that mounts a block's controls
as it nears the view.

Killed by new gate tests (8):
- 168:35, 191:69 and 213:12, in `start()`: no frame is asked for before the editor is in the page, and once it is, a block left waiting alone is watched.
- 233:20, in the two-screen measure.
- 264:12 ×2 and 265:9 ×2, in `firstReaching`: a page that ends in blocks a collapsed block hides.

Deleted rather than tested, each traced and confirmed by a second reviewer:
- the loop in `start()` that observed blocks already waiting. TipTap destroys the views built before the editor is in the page before it builds new ones, and an instrumented run across 125 test files always found one block waiting and none watched;
- `{ passive: true }` on a `scroll` listener, whose events cannot be cancelled;
- `listMarker`'s paragraph check and `update`'s marker redraw, both repeats of what `PageLists` already does through its notification;
- the `textContent` guard, always true once the marker draws only on a change;
- the no-id `''` marker fallback, the one no-coverage mutant: `followMarker` now takes the block's id, so no fallback exists.

A new test pins the marker through the list alone: a bullet block made a
heading by a remote patch loses its marker and gets it back as a paragraph.

Recorded equivalent: a second `observe` of a target, the observer's `?.`
after `start`, re-observing a kept block, and the `<=` before `found = at`. A
differential check found that last one changes the index but never the
blocks `pick` shows. 784:14's existing entry pointed at the wrong
`return true` occurrence and now names the right one.

Ran:
- Stryker on line ranges, because the full module run outlasted the box;
- vitest over `src/editor/page-mode` (867 passed) and `npm run typecheck`;
- the 197 Playwright specs `e2e-related` selected: 1,131 passed. The 2 that failed, `diagram-legibility` at phone and desktop width, fail the same way on the base source.
