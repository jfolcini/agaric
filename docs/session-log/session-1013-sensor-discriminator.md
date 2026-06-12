# Session 1013 — DnD sensor discriminator (#926 finding 1)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#926 finding 1 — align the drag-activation discriminator with the handle.** `useBlockDnD`'s
  PointerSensor chose its activation constraint by VIEWPORT WIDTH (`useIsMobile()`, < 768px),
  while the gutter/drag-handle renders by POINTER COARSENESS (`useIsTouch()`, `pointer:coarse`).
  The two disagreed at the edges:
  - a **narrow desktop window** (< 768px, mouse) got the 250ms press-and-hold sensor → laggy
    mouse drag;
  - a **large touch tablet** (≥ 768px, coarse pointer) got the 8px distance sensor → the drag
    fights scroll.
  Switched the sensor to `useIsTouch()` so coarse pointer → press-and-hold (250ms) and fine
  pointer → 8px distance, matching where the handle actually renders.

## Tests

`useBlockDnD` sensor tests updated to the touch discriminator (fine pointer → distance:8;
coarse → delay:250). 1834 unit tests green; desktop drag e2e (block-dnd-mouse, 5 specs) green
— desktop is fine-pointer either way, so no behavior change there; `tsc -b` clean.

## Deferred (commented on #926)

The other findings are device-dependent or test-coverage: long-press(400ms)/dnd(250ms) gesture
arbiter, touch-reorder can't change depth (context-menu only nudges sibling slots), touch
press-and-hold hint mis-tuned, e2e for the long-press→context-menu reorder fallback, and the
e2e drag helper faithfulness. They need a real device / touch-gesture harness.
