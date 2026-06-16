# Session 1001 — swipe-row gesture wiring + a11y (#1346, #1347, #1349)

`/loop /batch-issues` run (2026-06-16). Frontend cluster batch, picked as a disjoint domain
while #1324 (PR #1356, materializer/Rust) sat in CI — three tightly-related editor swipe-row
issues, all touching `SortableBlock.tsx`, shipped as one PR.

## Shipped

- **#1346 — swipe-to-indent/outdent gestures were dead code.** `useBlockSwipeActions`
  implements the gestures (`onIndent`/`onOutdent` options) but the sole call site
  (`SortableBlock.tsx`) passed no options object, so both were always `undefined`. Wired
  them to the `useBlockActions()` context's `onIndent` / `onDedent` (already bound to real
  indent/dedent ops in `BlockTree.tsx`), gated on presence so the gesture stays disabled
  wherever the action isn't wired. Touch users now get swipe-indent/outdent.

- **#1347 — swipe-row transition bypassed `prefers-reduced-motion`.** The slide used an
  inline `transition: 'transform 0.2s ease'`, which outranks the reduced-motion block's
  non-`!important` `*` override, so reduced-motion users still got the animation. Moved it to
  a `.swipe-content-sliding` class (`index.css`) driven by `transition: transform
  var(--duration-fast) ease`; the reduced-motion media query zeroes `--duration-fast` at
  `:root`, so the animation is now genuinely disabled for those users. The dynamic `transform`
  stays inline; behavior is otherwise preserved (class applied iff `isTouchDevice &&
  swipeTranslateX !== 0`).

- **#1349 — two a11y/design-system consistency gaps.**
  1. `SortableBlock.tsx` used the raw `aria-description` attribute (limited SR support, the
     only such usage in src). Replaced with an `sr-only` span (`id=swipe-row-desc-${blockId}`)
     referenced via `aria-describedby`, matching the codebase's standard.
  2. `AttachmentList.tsx` rename input used ad-hoc `focus:outline-none focus:ring-1`. Swapped
     for the canonical `focus-ring-visible` utility (the sibling action button already uses it).

## Tests

- `SortableBlock.test.tsx`: gesture-wiring (callbacks dispatch to the block actions with
  `blockId`; disabled when actions absent), token-class transition (class present, no inline
  transition), `aria-describedby` + sr-only span (no raw `aria-description`).
- `AttachmentList.test.tsx`: rename input carries `focus-ring-visible`, not `focus:ring-1`.
- Both suites green (226 tests in the two files); `tsc` clean. Independent adversarial
  reviewer verified the fixes + reduced-motion token mechanism.

Backend/Rust untouched — no UX visual review needed beyond the a11y assertions (the gestures
are touch-only and covered by the wiring test).
