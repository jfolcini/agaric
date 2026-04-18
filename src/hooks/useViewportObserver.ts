/**
 * Viewport Intersection Observer — virtualization lite (p15-t13).
 *
 * Off-screen blocks render as empty divs with preserved height.
 * IntersectionObserver drives the visible window with a 200px
 * rootMargin buffer for smooth scrolling. Zero TipTap overhead
 * for off-screen blocks.
 *
 * API: factory-per-id. `createObserveRef(id)` returns a memoized
 * ref callback scoped to that block id. When React calls the ref
 * with `null` (unmount) we unobserve the exact element that was
 * observed for that id, so detached DOM nodes are released
 * immediately instead of lingering in the observer's internal
 * strong-ref set until the hook itself unmounts (BUG-29).
 *
 * Usage:
 *   const viewport = useViewportObserver()
 *   <div ref={viewport.createObserveRef(id)} data-block-id={id}>
 *     {viewport.isOffscreen(id) ? <Placeholder height={viewport.getHeight(id)} /> : <Block />}
 *   </div>
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface ViewportObserver {
  /**
   * Returns a memoized ref callback scoped to `id`. Calling
   * `createObserveRef('X')` repeatedly returns the *same* function
   * reference, so React does not perceive the ref as changing and
   * won't churn observe/unobserve across renders.
   */
  createObserveRef: (id: string) => (el: HTMLElement | null) => void
  /** True if the block has been measured and is outside the viewport + margin. */
  isOffscreen: (id: string) => boolean
  /** Cached height for an off-screen block (px), or undefined if unknown. */
  getHeight: (id: string) => number | undefined
}

export function useViewportObserver(rootMargin = '200px 0px'): ViewportObserver {
  const [offscreenIds, setOffscreenIds] = useState<Set<string>>(() => new Set())
  const heightsRef = useRef<Map<string, number>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)
  /** id → currently-observed element. Lets the null-transition unobserve precisely. */
  const elementsByIdRef = useRef<Map<string, HTMLElement>>(new Map())
  /** id → memoized ref callback. Guarantees stable identity per id across renders. */
  const refCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map())

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setOffscreenIds((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset['blockId']
            if (!id) continue
            if (entry.isIntersecting && next.has(id)) {
              next.delete(id)
              changed = true
            } else if (!entry.isIntersecting && !next.has(id)) {
              heightsRef.current.set(id, entry.boundingClientRect.height)
              next.add(id)
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { rootMargin },
    )

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [rootMargin])

  const createObserveRef = useCallback((id: string) => {
    const cached = refCallbacksRef.current.get(id)
    if (cached) return cached

    const cb = (el: HTMLElement | null): void => {
      const previous = elementsByIdRef.current.get(id)
      if (el) {
        // Defensive: if React hands us a new element without first
        // calling the ref with null for the previous one, unobserve
        // the stale element so the observer doesn't retain it.
        if (previous && previous !== el) {
          observerRef.current?.unobserve(previous)
        }
        elementsByIdRef.current.set(id, el)
        observerRef.current?.observe(el)
      } else if (previous) {
        observerRef.current?.unobserve(previous)
        elementsByIdRef.current.delete(id)
        heightsRef.current.delete(id)
        setOffscreenIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    refCallbacksRef.current.set(id, cb)
    return cb
  }, [])

  const isOffscreen = useCallback((id: string) => offscreenIds.has(id), [offscreenIds])

  const getHeight = useCallback((id: string) => heightsRef.current.get(id), [])

  return { createObserveRef, isOffscreen, getHeight }
}
