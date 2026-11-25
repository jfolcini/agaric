import { useEffect, useRef } from 'react'

/** About three seconds at 60 Hz: the longest a restore waits for its view's content. */
const RESTORE_FRAMES = 180

/**
 * Saves and restores scroll position per view key on a scrollable container.
 *
 * Continuously tracks scroll position via a passive scroll listener and
 * restores the saved position when the view key changes, a frame later and
 * again each frame while the view's content is still too short to hold it.
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

  // On view change: restore the incoming view's position. Its content may still be
  // loading (a page's blocks arrive over IPC), and a position past what is drawn
  // clamps, so it is set again each frame as the content grows: until it holds, the
  // user scrolls by hand, or RESTORE_FRAMES pass.
  useEffect(() => {
    if (!container) return undefined
    if (prevViewRef.current === viewKey) return undefined
    prevViewRef.current = viewKey
    const target = scrollPositions.current.get(viewKey) ?? 0
    let frames = 0
    let rafId = requestAnimationFrame(function apply() {
      container.scrollTop = target
      if (container.scrollTop < target && ++frames < RESTORE_FRAMES) {
        rafId = requestAnimationFrame(apply)
      }
    })
    const stop = () => cancelAnimationFrame(rafId)
    container.addEventListener('wheel', stop, { passive: true })
    container.addEventListener('touchstart', stop, { passive: true })
    container.addEventListener('keydown', stop)
    return () => {
      stop()
      container.removeEventListener('wheel', stop)
      container.removeEventListener('touchstart', stop)
      container.removeEventListener('keydown', stop)
    }
  }, [viewKey, container])
}
