/**
 * useLinkPreview — hover/focus detection hook for external link preview tooltips.
 *
 * Attaches pointer event handlers to the TipTap editor DOM to detect hover
 * over `.external-link` elements. Also attaches focusin/focusout handlers so
 * keyboard-only users (Tab navigation) get the same preview affordance as
 * mouse users (UX-273). Returns the hovered/focused URL, cached/fetched
 * metadata, anchor rect for tooltip positioning, and loading state.
 *
 * Implements a 150ms debounce before triggering metadata fetches to avoid
 * rapid hover flicker. Uses a stale-request ref to cancel outdated fetches
 * when the user moves between links quickly.
 *
 * Escape dismisses the preview when shown, but only when no other handler
 * has already consumed the event (`event.defaultPrevented` check). This is
 * additive — the editor's own Escape semantics (blur, cancel suggestion)
 * are preserved.
 *
 * UX-165, UX-273
 */

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

export function useLinkPreview(container: HTMLElement | null): LinkPreviewState {
  const [state, setState] = useState<LinkPreviewState>(INITIAL_STATE)

  // Ref to track the current hovered/focused URL — used to discard stale fetches
  const activeUrlRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  // Shared open-preview implementation used by both pointerenter and focusin.
  const openPreview = useCallback(
    (anchor: HTMLElement) => {
      const href = anchor.getAttribute('href') ?? anchor.getAttribute('data-href')
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

  // Shared dismiss implementation used by pointerleave, focusout, and Escape.
  const dismissPreview = useCallback(() => {
    activeUrlRef.current = null
    clearDebounce()
    setState(INITIAL_STATE)
  }, [clearDebounce])

  const handlePointerEnter = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement
      // Match both editor links (<a class="external-link">) and
      // static-rendered links (<span class="external-link" data-href="...">)
      const anchor = target.closest('.external-link') as HTMLElement | null
      if (!anchor) return
      openPreview(anchor)
    },
    [openPreview],
  )

  const handlePointerLeave = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('.external-link') as HTMLElement | null
      if (!anchor) return
      dismissPreview()
    },
    [dismissPreview],
  )

  const handleFocusIn = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target) {
        logger.warn('useLinkPreview', 'focusin fired with null target')
        return
      }
      const anchor = target.closest('.external-link') as HTMLElement | null
      if (!anchor) return
      openPreview(anchor)
    },
    [openPreview],
  )

  const handleFocusOut = useCallback(
    (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target) {
        logger.warn('useLinkPreview', 'focusout fired with null target')
        return
      }
      const anchor = target.closest('.external-link') as HTMLElement | null
      if (!anchor) return
      // Guard against desync: dismissing a preview that was never shown is
      // a no-op but worth logging once so we notice ordering bugs.
      if (activeUrlRef.current === null) {
        logger.warn('useLinkPreview', 'focusout on link with no active preview', {
          href: anchor.getAttribute('href') ?? anchor.getAttribute('data-href'),
        })
        return
      }
      dismissPreview()
    },
    [dismissPreview],
  )

  // Window-level Escape dismissal. Additive: bails out when another handler
  // has already consumed the event (defaultPrevented), so the existing
  // editor / suggestion / modal Escape semantics keep working.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (activeUrlRef.current === null) return
      dismissPreview()
    },
    [dismissPreview],
  )

  useEffect(() => {
    if (!container) return

    container.addEventListener('pointerenter', handlePointerEnter, true)
    container.addEventListener('pointerleave', handlePointerLeave, true)
    container.addEventListener('focusin', handleFocusIn)
    container.addEventListener('focusout', handleFocusOut)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('pointerenter', handlePointerEnter, true)
      container.removeEventListener('pointerleave', handlePointerLeave, true)
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('focusout', handleFocusOut)
      window.removeEventListener('keydown', handleKeyDown)
      activeUrlRef.current = null
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [
    container,
    handlePointerEnter,
    handlePointerLeave,
    handleFocusIn,
    handleFocusOut,
    handleKeyDown,
  ])

  return state
}
