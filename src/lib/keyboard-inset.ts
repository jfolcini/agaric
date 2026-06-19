/**
 * computeKeyboardInset — single source of truth for the soft-keyboard overlap
 * math shared by `useScrollCaretAboveKeyboard`, `Sheet` (`useSoftKeyboardInset`),
 * and the pinned (touch) `FormattingToolbar` (#1515).
 *
 * `window.visualViewport` is the layout viewport MINUS the soft keyboard. Its
 * `height + offsetTop` is the y of the visible-viewport bottom in layout-viewport
 * coordinates, so `window.innerHeight - (vv.height + vv.offsetTop)` is the height
 * of the region the keyboard covers. Clamp 0 so transient negative readings
 * during orientation changes never produce a bogus inset.
 *
 * WHY the scale guard: pinch zoom ALSO shrinks `vv.height` without any keyboard
 * (desktop trackpad / touchscreen pinch, WebView2 touch zoom). A zoomed viewport
 * would otherwise report a phantom keyboard inset. `scale > 1` is the
 * discriminator — the IME never changes scale, pinch zoom always does.
 * (`undefined > 1` is false, so WebViews lacking `scale` keep the plain
 * keyboard math.)
 */
export function computeKeyboardInset(vv: VisualViewport): number {
  if (vv.scale > 1) return 0
  const overlap = window.innerHeight - (vv.height + vv.offsetTop)
  return overlap > 0 ? Math.round(overlap) : 0
}
