# Session 3335 — the DOING checkbox's dot is round and centred

The maintainer saw the DOING task checkbox's inner dot drawn neither round nor centred in its box (desktop app, dark theme). No issue; claimed by paths.

**Cause.** The dot was a `div` sized `0.375em` with `rounded-sm`, so it was a rounded square rather than a disc. Its size was in `em`: at the Small and Large font settings, and at any pixel ratio other than 1, it came to a fraction of a pixel inside a box that is snapped to whole pixels, so its background was snapped off centre. Measured from screenshots at ratios 1, 1.25, 1.5 and 2, light and dark: the dot sat 0.5–1 device px above the box's centre and was up to 1.8 device px taller than wide, in 12 of the 24 cases. A custom state's dot (`_custom`) had the same `em`-sized `div` (round, but snapped the same way). DONE's check and CANCELLED's cross are lucide SVGs filling a centred `em` box and looked centred; they were not changed.

**Fix.** `TaskDot` in `BlockInlineControls.tsx` draws the dot as an SVG `<circle>` at the centre of a viewBox that fills the box's inner square. That serves both DOING and custom states, in the same colour tokens and at the same 6 px at the Medium size. Both editing modes draw the same component.

**Tests.** `e2e/task-checkbox-dot.spec.ts` screenshots the DOING checkbox at each ratio, theme and font size, and reads the dot's coverage-weighted centre and extent against the ring's edges. It is red on `origin/main` (12 of 24), and green with the fix 96 times out of 96 under `--repeat-each=4`. The row's fade-in is turned off (`reducedMotion`): a screenshot taken mid-fade reads an unpainted box. `npx vitest run src/components/editor` passed.
