# Session 1002 — Caret above the soft keyboard (#917)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#917 — keyboard-aware editor scroll.** `EditableBlock`'s focus effect used
  `scrollIntoView({ block: 'nearest' })`, which is keyboard-unaware: the mobile soft
  keyboard shrinks `window.visualViewport` (not the layout viewport), so a block focused
  in the covered region stays "in view" per layout but hidden behind the keyboard. New
  `useScrollCaretAboveKeyboard(ref, enabled)` hook (`src/hooks/useScrollCaretAboveKeyboard.ts`):
  - `computeKeyboardInset(vv)` = `innerHeight − (vv.height + vv.offsetTop)`, clamped at 0,
    with the pinch-zoom (`scale > 1`) discriminator — mirrors `sheet.tsx`'s
    `useSoftKeyboardInset`.
  - `scrollCaretAboveKeyboard(el, vv)` — no inset / no visualViewport → plain
    `scrollIntoView({ block: 'nearest' })` (desktop byte-identical); keyboard up + element
    bottom within the covered region → nearest scroll, then nudge by the residual overshoot
    so the element clears the keyboard by an 8px margin.
  - The hook wires a rAF one-shot on focus + `visualViewport` `resize`/`scroll` listeners
    with full cleanup; guarded for SSR and absent `visualViewport`.

## Tests

- `src/hooks/__tests__/useScrollCaretAboveKeyboard.test.ts` — 12 cases: inset math (overlap,
  offsetTop, clamp, pinch-zoom), scroll helper (vv-absent fallback, inset-0 fallback,
  covered-element nudge, already-clear no-op), hook wiring (disabled no-op, listener
  add/remove, re-apply on resize, inert when vv absent). `Element.prototype.scrollIntoView`
  + `window.scrollBy` spied; visualViewport mocked via `FakeVisualViewport extends
  EventTarget`. `npx vitest run src/hooks src/components/editor` → 2915 passed; `tsc -b` clean.

## Caveat

On-device behavior (real Gboard/iOS soft keyboard driving a `visualViewport` resize) cannot
be exercised in jsdom or Playwright mobile emulation, so the math/logic is unit-tested but
the end-to-end scroll is pending real-device confirmation. The change degrades to the
previous behavior wherever no keyboard inset is reported, so it cannot regress desktop.
