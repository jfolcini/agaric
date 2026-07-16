/**
 * scrollElementIntoView — `Element.scrollIntoView` that honours the user's
 * `prefers-reduced-motion` setting.
 *
 * The global CSS forces `scroll-behavior: auto` under reduced motion, but a
 * JS `scrollIntoView({ behavior: 'smooth' })` option overrides that CSS — so a
 * raw smooth call still animates for users who asked for no motion (#2664).
 * This helper downgrades `'smooth'` → `'auto'` whenever
 * `(prefers-reduced-motion: reduce)` matches, giving imperative scroll sites a
 * single safe entry point (mirrors the inline downgrade already in
 * `useScrollToFocus`, `scrollIntoViewMatch`, and `QuickAccessBar`).
 *
 * Options are forwarded unchanged apart from the behavior downgrade, so callers
 * pass the same `ScrollIntoViewOptions` they would give `scrollIntoView`.
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function scrollElementIntoView(el: Element, options: ScrollIntoViewOptions = {}): void {
  const scrollOptions: ScrollIntoViewOptions = { ...options }
  if (scrollOptions.behavior === 'smooth' && prefersReducedMotion()) {
    scrollOptions.behavior = 'auto'
  }
  el.scrollIntoView(scrollOptions)
}
