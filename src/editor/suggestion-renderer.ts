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
  el.style.position = 'fixed'
  el.style.left = `${rect.left}px`
  el.style.top = `${rect.bottom + 4}px`
  el.style.zIndex = '50'
}

export function createSuggestionRenderer() {
  let renderer: ReactRenderer<SuggestionListRef> | null = null
  let popup: HTMLDivElement | null = null

  return {
    onStart(props: SuggestionProps) {
      renderer = new ReactRenderer(SuggestionList, {
        props,
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
