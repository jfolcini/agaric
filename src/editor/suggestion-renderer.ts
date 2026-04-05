/**
 * Suggestion popup renderer factory.
 *
 * Creates a floating popup that positions itself below the trigger
 * character using clientRect from the Suggestion plugin. Uses
 * ReactRenderer from @tiptap/react to render outside the main tree.
 */

import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { Editor } from '@tiptap/core'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { SuggestionList, type SuggestionListRef } from './SuggestionList'

async function updatePosition(
  el: HTMLElement,
  props: {
    editor: Editor
    range: { from: number; to: number }
    clientRect?: (() => DOMRect | null) | null
  },
): Promise<void> {
  if (!el) return

  // Try cursor position first (more accurate — follows the end of typed text)
  let rect: DOMRect | null = null
  try {
    const coords = props.editor.view.coordsAtPos(props.range.to)
    if (coords) {
      rect = new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top)
    }
  } catch {
    // Fallback to clientRect
  }

  // Fallback to trigger clientRect
  if (!rect && props.clientRect) {
    rect = props.clientRect()
  }

  if (!rect) return

  const virtualEl = {
    getBoundingClientRect: () => rect,
  }

  const { x, y } = await computePosition(virtualEl, el, {
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  Object.assign(el.style, {
    position: 'fixed',
    left: `${x}px`,
    top: `${y}px`,
    zIndex: '50',
  })
}

export function createSuggestionRenderer(label?: string) {
  let renderer: ReactRenderer<SuggestionListRef> | null = null
  let popup: HTMLDivElement | null = null
  let outsideClickHandler: ((e: PointerEvent) => void) | null = null

  function cleanupListener() {
    if (outsideClickHandler) {
      document.removeEventListener('pointerdown', outsideClickHandler, true)
      outsideClickHandler = null
    }
  }

  return {
    onStart(props: SuggestionProps) {
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
      popup.dataset.testid = 'suggestion-popup'
      document.body.appendChild(popup)
      popup.appendChild(renderer.element)
      void updatePosition(popup, props)

      // Dismiss popup on outside click (capture phase, like BlockContextMenu)
      outsideClickHandler = (e: PointerEvent) => {
        if (popup && !popup.contains(e.target as Node)) {
          cleanupListener()
          renderer?.destroy()
          renderer = null
          popup?.remove()
          popup = null
        }
      }
      document.addEventListener('pointerdown', outsideClickHandler, true)
    },

    onUpdate(props: SuggestionProps) {
      renderer?.updateProps(props)
      if (popup) void updatePosition(popup, props)
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === 'Escape') {
        cleanupListener()
        renderer?.destroy()
        renderer = null
        popup?.remove()
        popup = null
        return true
      }
      return renderer?.ref?.onKeyDown?.({ event }) ?? false
    },

    onExit() {
      cleanupListener()
      renderer?.destroy()
      renderer = null
      popup?.remove()
      popup = null
    },
  }
}
