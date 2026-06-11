# Session 1003 — Touch drag-handle hittability (#918 / #919)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#918 — touch drag handle is hittable on phones.** `SortableBlock`'s gutter wrapper
  applied `max-md:w-0 max-md:overflow-hidden` unconditionally, clipping the touch drag grip
  (the only element carrying the dnd-kit drag listeners) to zero width below 768px — so
  there was no target to start a drag on a phone. The collapse classes are now gated on
  `!isTouchDevice` (reusing the existing in-scope value): on a coarse-pointer device the
  gutter keeps its real width and the grip stays hittable; desktop fine-pointer hover-reveal
  collapse is unchanged.
- In `BlockGutterControls`, the touch grip was rendered via the hover-hidden `GutterButton`
  (`opacity-0 pointer-events-none` at rest). Replaced it with a plain always-visible
  `<button>` (`TOUCH_DRAG_HANDLE_CLASS`) that: has a ≥44×44 hit area (`touch-target`,
  WCAG 2.5.5), sets `touch-action: none` (`touch-none`) so the press-drag goes to the
  dnd-kit activator instead of scrolling, is calm at rest and firms up on press, and remains
  the dnd-kit activator (drag attributes/listeners, `aria-label` hint, `aria-keyshortcuts`,
  `data-context-trigger`, `drag-handle` testid).

- **#919 — retire the bug-enshrining test.** `SortableBlock.test.tsx` had a test asserting
  the gutter className contains `max-md:w-0` / `max-md:overflow-hidden` — locking in the
  bug. Scoped that to the unchanged desktop/fine-pointer case and added a new describe block
  that forces coarse pointer and asserts the grip (1) renders with no ancestor carrying
  `w-0`/`overflow-hidden`, (2) has `touch-target` + `touch-none` and is not
  `opacity-0`/`pointer-events-none`, and (3) is the dnd-kit activator. Added a matching
  `BlockGutterControls.test.tsx` touch case.

## Tests

`npx vitest run src/components/editor/__tests__/SortableBlock.test.tsx
src/components/editor/__tests__/BlockGutterControls.test.tsx` → 240 passed; `tsc -b` clean.

## Follow-up

A full `block-dnd-touch.spec.ts` e2e (simulating the 250 ms press-hold + touch drag through
dnd-kit) is high-flake and deferred; the unit tests guard the regression (hittability +
activator wiring + touch-action). File a follow-up if device QA wants the e2e.
