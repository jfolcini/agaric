/**
 * Suggestion popup renderer factory.
 *
 * Creates a floating popup that positions itself below the trigger
 * character using clientRect from the Suggestion plugin. Uses
 * ReactRenderer from @tiptap/react to render outside the main tree.
 */

import { computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { Editor } from '@tiptap/core'
import type { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { getShortcutKeys } from '../lib/keyboard-config'
import { logger } from '../lib/logger'
import { SuggestionList, type SuggestionListRef } from './SuggestionList'

/**
 * Mobile / touch viewports get a larger flip+shift padding (16px) plus a
 * `size()` middleware that caps the popup height at 60vh. Desktop keeps the
 * original 8px padding and natural sizing (UX-273). Detection is via
 * `(pointer: coarse)` so it matches the rest of the design system's
 * touch-target rules.
 */
const DESKTOP_PADDING = 8
const COARSE_PADDING = 16
const COARSE_MAX_HEIGHT_RATIO = 0.6

async function updatePosition(
  el: HTMLElement,
  props: {
    editor: Editor
    range: { from: number; to: number }
    clientRect?: (() => DOMRect | null) | null
  },
): Promise<void> {
  if (!el) return

  // Wait for the editor view to flush its DOM update so coordsAtPos returns fresh values
  await new Promise((resolve) => requestAnimationFrame(resolve))

  // Try cursor position first (more accurate — follows the end of typed text)
  let rect: DOMRect | null = null
  try {
    const coords = props.editor.view.coordsAtPos(props.range.to)
    if (coords) {
      rect = new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top)
    }
  } catch {
    logger.debug('SuggestionRenderer', 'coordsAtPos fallback to clientRect')
  }

  // Fallback to trigger clientRect
  if (!rect && props.clientRect) {
    rect = props.clientRect()
  }

  if (!rect) return

  const virtualEl = {
    getBoundingClientRect: () => rect,
  }

  // Mobile/touch viewports get a larger padding so popups don't clip near
  // the bottom of narrow viewports, plus a `size()` middleware that caps
  // the popup at 60vh. Desktop behavior is unchanged (UX-273).
  const isCoarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  const padding = isCoarsePointer ? COARSE_PADDING : DESKTOP_PADDING
  const middleware = [offset(4), flip({ padding }), shift({ padding })]
  if (isCoarsePointer) {
    middleware.push(
      size({
        padding,
        apply({ availableHeight, elements }) {
          const cap = window.innerHeight * COARSE_MAX_HEIGHT_RATIO
          const maxH = Math.max(0, Math.min(availableHeight, cap))
          Object.assign(elements.floating.style, {
            maxHeight: `${maxH}px`,
            overflowY: 'auto',
          })
        },
      }),
    )
  }

  const { x, y } = await computePosition(virtualEl, el, {
    placement: 'bottom-start',
    middleware,
  })

  Object.assign(el.style, {
    position: 'fixed',
    left: `${x}px`,
    top: `${y}px`,
    zIndex: '50',
  })
}

/**
 * Remove all orphaned `.suggestion-popup` elements from `document.body`.
 * Called as a safety net during mount/unmount to prevent DOM accumulation
 * when the normal `onExit()` lifecycle is bypassed (B-77).
 */
export function cleanupOrphanedPopups(): number {
  const orphans = document.querySelectorAll('.suggestion-popup')
  const count = orphans.length
  for (const el of orphans) el.remove()
  if (count > 0) {
    logger.warn('SuggestionRenderer', 'cleaned up orphaned popups', { count })
  }
  return count
}

export function createSuggestionRenderer(label?: string, pluginKey?: PluginKey) {
  let renderer: ReactRenderer<SuggestionListRef> | null = null
  let popup: HTMLDivElement | null = null
  let outsideClickHandler: ((e: PointerEvent) => void) | null = null
  let editorRef: Editor | null = null
  let deferredRegistrationId: number | null = null

  function cleanupListener() {
    if (deferredRegistrationId !== null) {
      cancelAnimationFrame(deferredRegistrationId)
      deferredRegistrationId = null
    }
    if (outsideClickHandler) {
      document.removeEventListener('pointerdown', outsideClickHandler, true)
      outsideClickHandler = null
    }
  }

  return {
    onStart(props: SuggestionProps) {
      logger.debug('SuggestionRenderer', 'onStart', { label, query: props.query })

      editorRef = props.editor

      // Clean up any previous popup to prevent DOM accumulation
      cleanupListener()
      if (renderer) renderer.destroy()
      if (popup) {
        popup.remove()
        popup = null
      }

      renderer = new ReactRenderer(SuggestionList, {
        props: { ...props, label },
        editor: props.editor,
      })

      popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      popup.dataset['testid'] = 'suggestion-popup'
      popup.setAttribute('role', 'region')
      popup.setAttribute('aria-label', label ?? 'Suggestions')
      // Start off-screen to avoid flash at (0,0) before positioning settles
      Object.assign(popup.style, {
        position: 'fixed',
        left: '-9999px',
        top: '-9999px',
        zIndex: '50',
      })
      document.body.appendChild(popup)
      popup.appendChild(renderer.element)
      updatePosition(popup, props).catch((err: unknown) => {
        logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
      })

      // Dismiss popup on outside click (capture phase, like BlockContextMenu).
      // Defer listener registration by one frame to avoid catching pointer events
      // from the same event loop tick that triggered the popup (BUG-2 fix).
      outsideClickHandler = (e: PointerEvent) => {
        if (popup && !popup.contains(e.target as Node)) {
          logger.warn('SuggestionRenderer', 'outside click — deactivating plugin', { label })
          // Deactivate the Suggestion plugin so it doesn't stay stuck
          // active with a null renderer (B-77 fix layer 1).
          if (editorRef && pluginKey) {
            if (editorRef.view.isDestroyed) {
              logger.warn('SuggestionRenderer', 'skipping exit dispatch — view destroyed', {
                label,
              })
            } else {
              try {
                const { tr } = editorRef.state
                tr.setMeta(pluginKey, { exit: true })
                tr.setMeta('addToHistory', false)
                editorRef.view.dispatch(tr)
              } catch (err) {
                logger.warn(
                  'SuggestionRenderer',
                  'failed to dispatch exit meta on outside click',
                  { label },
                  err,
                )
              }
            }
          }
          cleanupListener()
          renderer?.destroy()
          renderer = null
          popup?.remove()
          popup = null
        }
      }
      deferredRegistrationId = requestAnimationFrame(() => {
        deferredRegistrationId = null
        // Guard: popup may have been destroyed by onExit before the frame fires
        if (popup && outsideClickHandler) {
          document.addEventListener('pointerdown', outsideClickHandler, true)
        }
      })
    },

    onUpdate(props: SuggestionProps) {
      if (!renderer) {
        logger.warn(
          'SuggestionRenderer',
          'onUpdate called with null renderer — plugin state desync',
          { label, query: props.query },
        )
        return
      }
      renderer.updateProps(props)
      if (popup)
        updatePosition(popup, props).catch((err: unknown) => {
          logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
        })
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      const closeKey = getShortcutKeys('suggestionClose').toLowerCase()
      if (event.key.toLowerCase() === closeKey) {
        cleanupListener()
        renderer?.destroy()
        renderer = null
        popup?.remove()
        popup = null
        return true
      }
      // Space: let it pass through to the editor so it's inserted as text
      // in the query (e.g. [[multi word page]]). Without this, the shared
      // useListKeyboardNavigation hook would treat Space as item selection.
      const passKey = getShortcutKeys('suggestionPassSpace').toLowerCase()
      if ((event.key === ' ' && passKey === 'space') || event.key.toLowerCase() === passKey) {
        return false
      }
      // Tab: autocomplete with the currently highlighted item (same as Enter)
      const autocompleteKey = getShortcutKeys('suggestionAutocomplete').toLowerCase()
      if (event.key.toLowerCase() === autocompleteKey) {
        const syntheticEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        return renderer?.ref?.onKeyDown?.({ event: syntheticEnter }) ?? false
      }
      if (!renderer) {
        logger.warn('SuggestionRenderer', 'onKeyDown called with null renderer', {
          label,
          key: event.key,
        })
        return false
      }
      return renderer.ref?.onKeyDown?.({ event }) ?? false
    },

    onExit() {
      logger.debug('SuggestionRenderer', 'onExit', { label })
      cleanupListener()
      renderer?.destroy()
      renderer = null
      popup?.remove()
      popup = null
      editorRef = null
    },
  }
}
