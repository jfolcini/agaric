/**
 * scrollElementIntoView — `Element.scrollIntoView` that honours the user's
 * motion preference (`shouldReduceMotion`).
 *
 * The global CSS forces `scroll-behavior: auto` under reduced motion, but a
 * JS `scrollIntoView({ behavior: 'smooth' })` option overrides that CSS — so a
 * raw smooth call still animates for users who asked for no motion (#2664).
 * This helper downgrades `'smooth'` → `'auto'` whenever `shouldReduceMotion()`
 * says so, giving imperative scroll sites a single safe entry point.
 *
 * Options are forwarded unchanged apart from the behavior downgrade, so callers
 * pass the same `ScrollIntoViewOptions` they would give `scrollIntoView`.
 */

import { shouldReduceMotion } from '@/lib/preferences'

export function scrollElementIntoView(el: Element, options: ScrollIntoViewOptions = {}): void {
  const scrollOptions: ScrollIntoViewOptions = { ...options }
  if (scrollOptions.behavior === 'smooth' && shouldReduceMotion()) {
    scrollOptions.behavior = 'auto'
  }
  el.scrollIntoView(scrollOptions)
}
