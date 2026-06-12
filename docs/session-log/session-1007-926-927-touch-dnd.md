# Session 1007 — #926 f1/f2/f4/f5 + #927 f1 (touch DnD core)

Mostly verification + closing test/doc gaps (the source fixes pre-existed on main).

- **#926 f1** (sensor vs gutter discriminator) — already unified on `useIsTouch()` (coarse
  pointer) in `useBlockDnD.ts` and `BlockGutterControls.tsx`; verified + pre-existing test.
- **#927 f1** (phone gutter clipped to 0 width) — already fixed: the `max-md:w-0` collapse is
  gated `!isTouchDevice` so the touch grip stays hittable; verified + pre-existing test.
- **#926 f5** (touch hint mismatch) — gesture unchanged (grip + 250ms hold), hint accurate;
  verified, no change.
- **#926 f4** (touch reorder can't change nesting) — touch drag is a full @dnd-kit drag;
  `getProjection` offsetLeft is input-agnostic. **Added a test** asserting a rightward touch
  drag projects `{depth:1}` (guards against a future touch-only regression).
- **#926 f2** (long-press 400ms vs drag 250ms racing) — **documented the precedence** in
  `useBlockTouchLongPress.ts` (on the handle the drag wins via eager `clearLongPress()` on
  drag activation + a lazy `isDraggingRef` re-check; elsewhere long-press wins) and **added
  tests** (drag activation cancels the pending long-press; no-drag → long-press fires).

Verification: `vitest` useBlockTouchLongPress + useBlockDnD (124 + 201) green; `tsc -b` clean.
No behavior change — verification + precedence docs + coverage.
