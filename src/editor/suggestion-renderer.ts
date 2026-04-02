/**
 * Suggestion popup renderer factory.
 *
 * Creates a floating popup that positions itself below the trigger
 * character using clientRect from the Suggestion plugin. Uses
 * ReactRenderer from @tiptap/react to render outside the main tree.
 */

import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { SuggestionList, type SuggestionListRef } from './SuggestionList'

function updatePosition(
  el: HTMLElement,
  clientRect: (() => DOMRect | null) | null | undefined,
): void {
  if (!el || !clientRect) return
  const rect = clientRect()
  if (!rect) return

  const popupHeight = el.offsetHeight || 200
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth

  // Place below by default; flip above if near viewport bottom
  let top = rect.bottom + 4
  if (top + popupHeight > viewportHeight - 8) {
    top = rect.top - popupHeight - 4
  }

  // Position at the end of the trigger text (where cursor is), not the start.
  // For multi-char triggers like [[, clientRect spans the trigger — we want
  // the right edge so the popup appears where the user is typing.
  let left = rect.width > 1 ? rect.right : rect.left
  const popupWidth = el.offsetWidth || 240
  if (left + popupWidth > viewportWidth - 8) {
    left = viewportWidth - popupWidth - 8
  }

  el.style.position = 'fixed'
  el.style.left = `${Math.max(8, left)}px`
  el.style.top = `${Math.max(8, top)}px`
  el.style.zIndex = '100'
}

export function createSuggestionRenderer(label?: string) {
  let renderer: ReactRenderer<SuggestionListRef> | null = null
  let popup: HTMLDivElement | null = null

  return {
    onStart(props: SuggestionProps) {
      // Clean up any previous popup to prevent DOM accumulation
      if (renderer) renderer.destroy()
      if (popup) { popup.remove(); popup = null }

      renderer = new ReactRenderer(SuggestionList, {
        props: { ...props, label },
        editor: props.editor,
      })

      popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      document.body.appendChild(popup)
      popup.appendChild(renderer.element)
      updatePosition(popup, props.clientRect)
    },

    onUpdate(props: SuggestionProps) {
      renderer?.updateProps(props)
      if (popup) updatePosition(popup, props.clientRect)
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === 'Escape') {
        popup?.remove()
        popup = null
        return true
      }
      return renderer?.ref?.onKeyDown?.({ event }) ?? false
    },

    onExit() {
      renderer?.destroy()
      renderer = null
      popup?.remove()
      popup = null
    },
  }
}
