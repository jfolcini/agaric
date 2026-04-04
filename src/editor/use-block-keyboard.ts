/**
 * useBlockKeyboard — keyboard boundary handling for the roving editor.
 *
 * ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block.
 * Backspace on empty → delete block + focus prev. Enter → create new sibling.
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
  /** Merge current block with previous (Backspace at start of non-empty block). */
  onMergeWithPrev: () => void
  /** Flush current content and close the editor. Called on Enter. */
  onEnterSave: () => void
  /** Escape pressed — cancel editing, discard changes, unfocus. */
  onEscapeCancel: () => void
  /** Move block up among siblings (Ctrl/Cmd+Shift+ArrowUp). */
  onMoveUp?: (() => void) | undefined
  /** Move block down among siblings (Ctrl/Cmd+Shift+ArrowDown). */
  onMoveDown?: (() => void) | undefined
  /** Toggle task state (Ctrl/Cmd+Enter). */
  onToggleTodo?: (() => void) | undefined
  /** Toggle collapse/expand children (Ctrl/Cmd+.). */
  onToggleCollapse?: (() => void) | undefined
  /** Show block properties drawer (Ctrl/Cmd+Shift+P). */
  onShowProperties?: (() => void) | undefined
}

/** Minimal editor shape needed by the key handler (for testability). */
export interface EditorState {
  selection: { from: number; to: number; empty: boolean }
  doc: { content: { size: number } }
}

export interface EditorLike {
  state: EditorState
  isEmpty: boolean
}

/**
 * Pure key-down handler for block keyboard navigation.
 * Extracted from the hook for direct unit testing.
 */
export function handleBlockKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'preventDefault'>,
  editor: EditorLike,
  callbacks: BlockKeyboardCallbacks,
): void {
  const { key, shiftKey, ctrlKey, metaKey } = event
  const { from, to, empty: selectionEmpty } = editor.state.selection
  const docSize = editor.state.doc.content.size
  const atStart = from <= 1 && selectionEmpty
  const atEnd = to >= docSize - 1 && selectionEmpty
  const isEmpty = editor.isEmpty

  // Ctrl/Cmd+Shift+ArrowUp: move block up among siblings
  if ((ctrlKey || metaKey) && shiftKey && key === 'ArrowUp') {
    event.preventDefault()
    callbacks.onFlush()
    callbacks.onMoveUp?.()
    return
  }

  // Ctrl/Cmd+Shift+ArrowDown: move block down among siblings
  if ((ctrlKey || metaKey) && shiftKey && key === 'ArrowDown') {
    event.preventDefault()
    callbacks.onFlush()
    callbacks.onMoveDown?.()
    return
  }

  // Ctrl/Cmd+Enter: toggle task state
  if ((ctrlKey || metaKey) && key === 'Enter') {
    event.preventDefault()
    callbacks.onToggleTodo?.()
    return
  }

  // Ctrl/Cmd+.: toggle collapse/expand children
  if ((ctrlKey || metaKey) && key === '.') {
    event.preventDefault()
    callbacks.onToggleCollapse?.()
    return
  }

  // Ctrl/Cmd+Shift+P: show block properties drawer
  if ((ctrlKey || metaKey) && shiftKey && (key === 'P' || key === 'p')) {
    event.preventDefault()
    callbacks.onShowProperties?.()
    return
  }

  // Tab / Shift+Tab: indent / dedent
  if (key === 'Tab') {
    event.preventDefault()
    callbacks.onFlush()
    if (shiftKey) {
      callbacks.onDedent()
    } else {
      callbacks.onIndent()
    }
    return
  }

  // Enter (without Shift): save current block and create a new sibling below.
  // Shift+Enter falls through to TipTap's HardBreak (line within same block).
  if (key === 'Enter' && !shiftKey) {
    event.preventDefault()
    callbacks.onEnterSave()
    return
  }

  // Escape: cancel editing, discard changes, unfocus.
  if (key === 'Escape') {
    event.preventDefault()
    callbacks.onEscapeCancel()
    return
  }

  // ArrowUp / ArrowLeft at position 0 → previous block
  if ((key === 'ArrowUp' || key === 'ArrowLeft') && atStart) {
    event.preventDefault()
    callbacks.onFlush()
    callbacks.onFocusPrev()
    return
  }

  // ArrowDown / ArrowRight at end → next block
  if ((key === 'ArrowDown' || key === 'ArrowRight') && atEnd) {
    event.preventDefault()
    callbacks.onFlush()
    callbacks.onFocusNext()
    return
  }

  // Backspace on empty block → delete block
  if (key === 'Backspace' && isEmpty) {
    event.preventDefault()
    callbacks.onDeleteBlock()
    return
  }

  // Backspace at start of non-empty block → merge with previous block (p2-t11)
  if (key === 'Backspace' && atStart && !isEmpty) {
    event.preventDefault()
    callbacks.onMergeWithPrev()
    return
  }
}

export function useBlockKeyboard(editor: Editor | null, callbacks: BlockKeyboardCallbacks): void {
  const {
    onFocusPrev,
    onFocusNext,
    onDeleteBlock,
    onIndent,
    onDedent,
    onFlush,
    onMergeWithPrev,
    onEnterSave,
    onEscapeCancel,
    onMoveUp,
    onMoveDown,
    onToggleTodo,
    onToggleCollapse,
    onShowProperties,
  } = callbacks

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!editor) return
      handleBlockKeyDown(event, editor, {
        onFocusPrev,
        onFocusNext,
        onDeleteBlock,
        onIndent,
        onDedent,
        onFlush,
        onMergeWithPrev,
        onEnterSave,
        onEscapeCancel,
        onMoveUp,
        onMoveDown,
        onToggleTodo,
        onToggleCollapse,
        onShowProperties,
      })
    },
    [
      editor,
      onFocusPrev,
      onFocusNext,
      onDeleteBlock,
      onIndent,
      onDedent,
      onFlush,
      onMergeWithPrev,
      onEnterSave,
      onEscapeCancel,
      onMoveUp,
      onMoveDown,
      onToggleTodo,
      onToggleCollapse,
      onShowProperties,
    ],
  )

  useEffect(() => {
    if (!editor) return

    const dom = editor.view.dom
    dom.addEventListener('keydown', handleKeyDown)
    return () => dom.removeEventListener('keydown', handleKeyDown)
  }, [editor, handleKeyDown])
}
