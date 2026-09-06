/**
 * usePrefersReducedMotion — reactive `shouldReduceMotion()` (#3285).
 *
 * Returns `true` when motion should be suppressed — either the app's own
 * Animations preference says `'off'`, or it defers to the OS and the OS asks
 * for reduced motion. Reactive to both inputs: the OS query's `change` event
 * and the `storage` event `writePreference` broadcasts when the Settings knob
 * moves.
 *
 * SSR-safe: the resolver returns `false` without a `window`, and both
 * listeners attach inside `useEffect`.
 *
 * Mirrors `useIsTouch` (#755) so that the resolver is read once on mount via a
 * useState initializer + subscriptions, rather than re-evaluated in a render
 * body on every render.
 */

import { useEffect, useState } from 'react'

import { shouldReduceMotion } from '@/hooks/useMotionPreference'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(shouldReduceMotion)

  useEffect(() => {
    const sync = () => {
      setPrefersReducedMotion(shouldReduceMotion())
    }
    // Sync once in case the initial state is stale (e.g. hydration mismatch).
    sync()
    window.addEventListener('storage', sync)
    const mql =
      typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null
    mql?.addEventListener('change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      mql?.removeEventListener('change', sync)
    }
  }, [])

  return prefersReducedMotion
}
