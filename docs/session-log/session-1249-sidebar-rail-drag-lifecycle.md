# Session 1249 — sidebar rail drag lifecycle

Single-issue session, 2026-08-04. #3335 grouped two defects in the same pointer-drag
state machine: a collapsed sidebar could not be opened by a normal incremental drag, and
unmounting the rail during a drag left the document stuck with a resize cursor and text
selection disabled.

## What was wrong

A collapsed drag starts at width zero. The first movement beyond the two-pixel hysteresis
therefore produced a width between 3 and 47 pixels, immediately entered the
"below icon width" collapse branch, and tore down the gesture. The old regression test
jumped directly from 0 to 80 pixels, skipping the range where real pointer input failed.

The hook also had three separate teardown implementations. Pointer-up and the collapse
branch cleared the document listeners and global styles, while the unmount effect removed
only the listeners. If the rail disappeared during an in-flight drag, the application kept
`cursor: col-resize` and `user-select: none` until reload.

## Shipped

- A collapsed drag now records whether it has reached the 48-pixel icon width. It may widen
  through the sub-threshold range and only recollapses after crossing that boundary and
  dragging back below it.
- All exit paths share one teardown: pointer-up, pointer cancellation, recollapse,
  replacement pointer-down, and unmount. The helper removes every document listener,
  clears the active state, and restores the exact inline cursor and selection values that
  existed before the drag.
- The hook now listens for `pointercancel`, so an interrupted pointer sequence cannot leave
  resize state or document styles behind. Cancellation never falls through to the rail's
  click-to-toggle behavior.
- The hook-level regression uses realistic incremental movements (`3, 10, 25, 60, 120`)
  and proves the gesture remains live below the threshold. A provider-level regression
  proves the durable result through `useSidebarState`'s intentional 120-pixel width clamp:
  the sidebar ends expanded at 180 pixels and persists that width.

## Review corrections

The first implementation covered the two reported defects. Independent UX and technical
passes strengthened the lifecycle contract in four places before commit: they added the
`pointercancel` path, made the recollapse test start from a genuinely collapsed width-zero
gesture, preserved pre-existing global inline styles instead of always restoring empty
strings, and protected against a second pointer-down orphaning the first gesture's
listeners. The technical pass also added the stateful provider test so the fix is verified
against the real clamping behavior rather than only mock call shapes.

## Verification

- `oxfmt` and `oxlint` on the three changed frontend files.
- Focused Vitest: 2 files, 52 tests passed.
- Full Vitest: 729 files and 15,921 tests passed; one unrelated syntax-highlighting
  cap-boundary test timed out under whole-suite contention. Its complete file then passed
  independently, 18/18, in 2.4 seconds.
- Two independent review passes: UX/behavior and technical/adversarial.
