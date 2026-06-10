import { useEffect, useRef } from 'react'

/**
 * Saves and restores scroll position per view key on a scrollable container.
 *
 * Continuously tracks scroll position via a passive scroll listener and
 * restores the saved position when the view key changes. Uses
 * `requestAnimationFrame` for restore timing to let the DOM settle.
 *
 * Accepts the container *element* (state, not a ref) so the effects re-run
 * when the scroll viewport mounts late — the App shell's viewport only
 * attaches after the boot gate resolves, and a ref's `.current` mutation
 * never re-fires an effect, which previously left the very first view
 * without a scroll listener until the first navigation (#754).
 *
 * Respects `prefers-reduced-motion` automatically — the global CSS rule
 * in `index.css` sets `scroll-behavior: auto` when reduced motion is
 * preferred.
 */
export function useScrollRestore(container: HTMLElement | null, viewKey: string): void {
  const scrollPositions = useRef<Map<string, number>>(new Map())
  const prevViewRef = useRef(viewKey)

  // Continuously save scroll position for the current view
  useEffect(() => {
    if (!container) return undefined

    const key = viewKey
    function handleScroll() {
      scrollPositions.current.set(key, container?.scrollTop ?? 0)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [viewKey, container])

  // On view change: restore scroll position for the incoming view
  useEffect(() => {
    if (!container) return undefined

    if (prevViewRef.current !== viewKey) {
      prevViewRef.current = viewKey
      const savedPosition = scrollPositions.current.get(viewKey) ?? 0
      const rafId = requestAnimationFrame(() => {
        container.scrollTop = savedPosition
      })
      return () => cancelAnimationFrame(rafId)
    }
    return undefined
  }, [viewKey, container])
}
