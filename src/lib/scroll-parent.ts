/**
 * Nearest scrollable ancestor lookups.
 *
 * Two callers need this walk with different axes, so the walk lives here once
 * and each axis is a thin export rather than a copy: `useViewportObserver`
 * wants the VERTICAL scroller (it becomes an IntersectionObserver `root`, and
 * a horizontally-scrolling ancestor would be the wrong box to measure a
 * vertical list against), while `DiffDisplay`'s scroll-skip heuristic wants any
 * scroller on either axis.
 */

/** Walk `el`'s ancestors, returning the first whose overflow `test` accepts. */
function nearestAncestor(
  el: HTMLElement,
  test: (style: CSSStyleDeclaration) => boolean,
): HTMLElement | null {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    if (test(window.getComputedStyle(cur))) return cur
  }
  return null
}

/**
 * The nearest ancestor that scrolls VERTICALLY, or `null` when none does (in
 * which case the viewport scrolls it).
 *
 * #5066 — an IntersectionObserver's `rootMargin` expands the ROOT's rect and
 * nothing else: an intermediate `overflow` ancestor still clips with no margin
 * at all. The block list lives inside a `ScrollArea`, so with the implicit
 * (viewport) root the documented 200px buffer was inert and a row was
 * virtualized away the instant it crossed the container edge — measured at 31px
 * out, after Enter scrolled the pane 55px to follow the new block. The row it
 * left behind is a bare placeholder, so the block the user had just edited read
 * as gone until they scrolled back.
 */
export function scrollParentY(el: HTMLElement): HTMLElement | null {
  return nearestAncestor(el, ({ overflowY }) => overflowY === 'auto' || overflowY === 'scroll')
}

/**
 * The nearest ancestor that scrolls on EITHER axis, `overlay` included.
 *
 * Wider than {@link scrollParentY} on purpose: its caller only asks "is there a
 * scroller between me and the page", to decide whether `scrollIntoView` is
 * needed at all.
 */
export function scrollParentAny(el: HTMLElement): HTMLElement | null {
  return nearestAncestor(el, (style) =>
    /auto|scroll|overlay/.test(`${style.overflow} ${style.overflowY} ${style.overflowX}`),
  )
}
