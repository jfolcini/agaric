/**
 * useLinkPreview — hover detection hook for external link preview tooltips.
 *
 * Attaches pointer event handlers to the TipTap editor DOM to detect hover
 * over `.external-link` elements. Returns the hovered URL, cached/fetched
 * metadata, anchor rect for tooltip positioning, and loading state.
 *
 * Implements a 150ms debounce before triggering metadata fetches to avoid
 * rapid hover flicker. Uses a stale-request ref to cancel outdated fetches
 * when the user moves between links quickly.
 *
 * UX-165
 */

import type { Editor } from '@tiptap/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import { fetchLinkMetadata, getLinkMetadata, type LinkMetadata } from '@/lib/tauri'

export interface LinkPreviewState {
  url: string | null
  metadata: LinkMetadata | null
  anchorRect: DOMRect | null
  isLoading: boolean
}

const INITIAL_STATE: LinkPreviewState = {
  url: null,
  metadata: null,
  anchorRect: null,
  isLoading: false,
}

const DEBOUNCE_MS = 150

export function useLinkPreview(editor: Editor | null): LinkPreviewState {
  const [state, setState] = useState<LinkPreviewState>(INITIAL_STATE)

  // Ref to track the current hovered URL — used to discard stale fetches
  const activeUrlRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const handlePointerEnter = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a.external-link') as HTMLAnchorElement | null
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href) return

      const rect = anchor.getBoundingClientRect()
      activeUrlRef.current = href

      // Set URL and rect immediately (so tooltip shell can appear)
      setState({
        url: href,
        metadata: null,
        anchorRect: rect,
        isLoading: true,
      })

      // Debounce the metadata fetch
      clearDebounce()
      debounceTimerRef.current = setTimeout(() => {
        // Guard: if user already moved away, skip
        if (activeUrlRef.current !== href) return

        // Try cache first
        getLinkMetadata(href)
          .then((cached) => {
            if (activeUrlRef.current !== href) return
            if (cached) {
              setState((prev) => ({
                ...prev,
                metadata: cached,
                isLoading: false,
              }))
              return
            }
            // Cache miss — fetch from network
            return fetchLinkMetadata(href).then((fetched) => {
              if (activeUrlRef.current !== href) return
              setState((prev) => ({
                ...prev,
                metadata: fetched,
                isLoading: false,
              }))
            })
          })
          .catch((err: unknown) => {
            if (activeUrlRef.current !== href) return
            logger.warn('useLinkPreview', 'metadata fetch failed', { url: href }, err)
            setState((prev) => ({ ...prev, isLoading: false }))
          })
      }, DEBOUNCE_MS)
    },
    [clearDebounce],
  )

  const handlePointerLeave = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a.external-link') as HTMLAnchorElement | null
      if (!anchor) return

      activeUrlRef.current = null
      clearDebounce()
      setState(INITIAL_STATE)
    },
    [clearDebounce],
  )

  useEffect(() => {
    const dom = editor?.view?.dom
    if (!dom) return

    dom.addEventListener('pointerenter', handlePointerEnter, true)
    dom.addEventListener('pointerleave', handlePointerLeave, true)

    return () => {
      dom.removeEventListener('pointerenter', handlePointerEnter, true)
      dom.removeEventListener('pointerleave', handlePointerLeave, true)
      activeUrlRef.current = null
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [editor?.view?.dom, handlePointerEnter, handlePointerLeave])

  return state
}
