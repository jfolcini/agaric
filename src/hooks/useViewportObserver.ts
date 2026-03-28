/**
 * Viewport Intersection Observer — virtualization lite (p15-t13).
 *
 * Off-screen blocks render as empty divs with preserved height.
 * IntersectionObserver drives the visible window with a 200px
 * rootMargin buffer for smooth scrolling. Zero TipTap overhead
 * for off-screen blocks.
 *
 * Usage:
 *   const viewport = useViewportObserver()
 *   <div ref={viewport.observeRef} data-block-id={id}>
 *     {viewport.isOffscreen(id) ? <Placeholder height={viewport.getHeight(id)} /> : <Block />}
 *   </div>
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface ViewportObserver {
  /** Ref callback — attach to each block wrapper div. */
  observeRef: (el: HTMLElement | null) => void
  /** True if the block has been measured and is outside the viewport + margin. */
  isOffscreen: (id: string) => boolean
  /** Cached height for an off-screen block (px), or undefined if unknown. */
  getHeight: (id: string) => number | undefined
}

export function useViewportObserver(rootMargin = '200px 0px'): ViewportObserver {
  const [offscreenIds, setOffscreenIds] = useState<Set<string>>(() => new Set())
  const heightsRef = useRef<Map<string, number>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setOffscreenIds((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.blockId
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

  const observeRef = useCallback((el: HTMLElement | null) => {
    if (el && observerRef.current) {
      observerRef.current.observe(el)
    }
  }, [])

  const isOffscreen = useCallback((id: string) => offscreenIds.has(id), [offscreenIds])

  const getHeight = useCallback((id: string) => heightsRef.current.get(id), [])

  return { observeRef, isOffscreen, getHeight }
}
