/**
 * useBlockKeyboard — keyboard boundary handling for the roving editor (ADR-01).
 *
 * ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block.
 * Backspace on empty → delete block + focus prev. Enter → insert \n.
 * Tab → indent. Shift+Tab → dedent.
 */

import type { Editor } from '@tiptap/core'
import { useCallback, useEffect } from 'react'

export interface BlockKeyboardCallbacks {
  /** Focus the previous block. Called with cursor-to-end hint. */
  onFocusPrev: () => void
  /** Focus the next block. Called with cursor-to-start hint. */
  onFocusNext: () => void
  /** Delete the current block (empty + backspace). */
  onDeleteBlock: () => void
  /** Indent the current block (Tab). */
  onIndent: () => void
  /** Dedent the current block (Shift+Tab). */
  onDedent: () => void
  /** Flush current content before navigation. Returns new markdown or null. */
  onFlush: () => string | null
}

export function useBlockKeyboard(editor: Editor | null, callbacks: BlockKeyboardCallbacks): void {
  const { onFocusPrev, onFocusNext, onDeleteBlock, onIndent, onDedent, onFlush } = callbacks

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!editor) return

      const { key, shiftKey } = event
      const { from, to, empty: selectionEmpty } = editor.state.selection
      const docSize = editor.state.doc.content.size
      const atStart = from <= 1 && selectionEmpty
      const atEnd = to >= docSize - 1 && selectionEmpty
      const isEmpty = editor.isEmpty

      // Tab / Shift+Tab: indent / dedent
      if (key === 'Tab') {
        event.preventDefault()
        onFlush()
        if (shiftKey) {
          onDedent()
        } else {
          onIndent()
        }
        return
      }

      // ArrowUp / ArrowLeft at position 0 → previous block
      if ((key === 'ArrowUp' || key === 'ArrowLeft') && atStart) {
        event.preventDefault()
        onFlush()
        onFocusPrev()
        return
      }

      // ArrowDown / ArrowRight at end → next block
      if ((key === 'ArrowDown' || key === 'ArrowRight') && atEnd) {
        event.preventDefault()
        onFlush()
        onFocusNext()
        return
      }

      // Backspace on empty block → delete block
      if (key === 'Backspace' && isEmpty) {
        event.preventDefault()
        onDeleteBlock()
        return
      }
    },
    [editor, onFocusPrev, onFocusNext, onDeleteBlock, onIndent, onDedent, onFlush],
  )

  useEffect(() => {
    if (!editor) return

    const dom = editor.view.dom
    dom.addEventListener('keydown', handleKeyDown)
    return () => dom.removeEventListener('keydown', handleKeyDown)
  }, [editor, handleKeyDown])
}
