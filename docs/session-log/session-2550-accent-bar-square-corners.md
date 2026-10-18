# Session 2550 — an accent bar's side has square corners

**Asked:** the maintainer pointed out that the embed's accent bar sat on
a rounded corner, and asked for every such bar to be fixed. A coloured
border on one side of a rounded box bends into a tapered crescent at
both ends.

**Swept** the frontend for one-side bars: `border-{l,r,t,b,s,e}-*`
classes, CSS `border-left` and friends, inset shadows, and absolutely
placed bar elements. Two sat on a rounded box:
- `.embed-container` (`src/index.css`): `rounded-md` with a 2 px rail on
  the left. Now `rounded-r-md`.
- A nested `FilterGroup` in the Advanced Query builder: `rounded-md
  border` with a 2 px left border in the same grey. That is not an accent
  bar but one side drawn thicker, which reads as a glitch (the
  maintainer's call), so the `border-l-2` is gone: the group is told
  apart by its indent and tint, with one border width all round.

Already right: callouts round only their right side; plain blockquotes
and indent guides have no radius; the other one-side borders are row
dividers.

**Rule:** `docs/UX.md` § Design tokens, Radius now says a border is one
width all round, and an accent bar is a border in its own colour on one
side only, with that side's corners square.

**Tests:** `embed-render-states.spec.ts` (page embed) asserts both left
corners are `0px`; shown red with `rounded-md` put back ("Expected 0px,
Received 6px"). `advanced-query-happy-paths.spec.ts` (nested group)
asserts a 1 px left border; shown red with `border-l-2` put back.
