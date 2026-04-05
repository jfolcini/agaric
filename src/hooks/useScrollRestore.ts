import { useEffect, useRef } from 'react'

/**
 * Saves and restores scroll position per view key on a scrollable container.
 *
 * Continuously tracks scroll position via a passive scroll listener and
 * restores the saved position when the view key changes. Uses
 * `requestAnimationFrame` for restore timing to let the DOM settle.
 *
 * Respects `prefers-reduced-motion` automatically — the global CSS rule
 * in `index.css` sets `scroll-behavior: auto` when reduced motion is
 * preferred.
 */
export function useScrollRestore(
  containerRef: React.RefObject<HTMLElement | null>,
  viewKey: string,
): void {
  const scrollPositions = useRef<Map<string, number>>(new Map())
  const prevViewRef = useRef(viewKey)

  // Continuously save scroll position for the current view
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const key = viewKey
    function handleScroll() {
      scrollPositions.current.set(key, container?.scrollTop ?? 0)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [viewKey, containerRef])

  // On view change: restore scroll position for the incoming view
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (prevViewRef.current !== viewKey) {
      prevViewRef.current = viewKey
      const savedPosition = scrollPositions.current.get(viewKey) ?? 0
      requestAnimationFrame(() => {
        container.scrollTop = savedPosition
      })
    }
  }, [viewKey, containerRef])
}
