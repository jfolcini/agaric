/**
 * useBlockKeyboard — keyboard boundary handling for the roving editor.
 *
 * ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block.
 * Backspace on empty → delete block + focus prev. Enter → create new sibling.
 * Ctrl/Cmd+Shift+ArrowRight → indent. Ctrl/Cmd+Shift+ArrowLeft → dedent.
 */

import type { Editor } from '@tiptap/core'
import { useCallback, useEffect } from 'react'
import { matchesShortcutBinding } from '../lib/keyboard-config'

/**
 * Check whether a suggestion popup (.suggestion-popup) is currently visible.
 * Used to suppress arrow-key block navigation when a popup menu is open,
 * so Up/Down scroll the menu instead of switching blocks.
 */
function isSuggestionPopupVisible(): boolean {
  const popup = document.querySelector('.suggestion-popup') as HTMLElement | null
  if (!popup) return false
  // A `.suggestion-popup` element can survive in memory after being detached
  // from the document (e.g. a leaked TipTap renderer). `checkVisibility()`
  // returns `false` for detached nodes in modern browsers, but `offsetParent`
  // is `null` for both `display:none` and detached nodes — so the fallback
  // path can't tell them apart. Bail explicitly on detached nodes so a stale
  // popup never swallows arrow-key block navigation.
  if (!popup.isConnected) return false
  return typeof popup.checkVisibility === 'function'
    ? popup.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : popup.offsetParent !== null
}

export interface DeleteBlockOpts {
  /** Where to place the cursor in the target block after deletion. */
  cursorPlacement: 'end'
}

export interface BlockKeyboardCallbacks {
  /** Focus the previous block. Called with cursor-to-end hint. */
  onFocusPrev: () => void
  /** Focus the next block. Called with cursor-to-start hint. */
  onFocusNext: () => void
  /** Delete the current block (empty + backspace). Receives cursor placement hint. */
  onDeleteBlock: (opts: DeleteBlockOpts) => void
  /** Indent the current block (Ctrl/Cmd+Shift+ArrowRight). */
  onIndent: () => void
  /** Dedent the current block (Ctrl/Cmd+Shift+ArrowLeft). */
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
  /**
   * Whether the current block is the sole remaining block on the page.
   * When true, Backspace on an empty block is a no-op (prevents empty page).
   */
  isLastBlock?: (() => boolean) | undefined
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
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'
  >,
  editor: EditorLike,
  callbacks: BlockKeyboardCallbacks,
): void {
  const { from, to, empty: selectionEmpty } = editor.state.selection
  const docSize = editor.state.doc.content.size
  const ctx: KeyContext = {
    atStart: from <= 1 && selectionEmpty,
    atEnd: to >= docSize - 1 && selectionEmpty,
    isEmpty: editor.isEmpty,
  }
  for (const rule of KEY_RULES) {
    if (rule.match(event, ctx)) {
      rule.handle(event, callbacks, ctx)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch infrastructure
// ---------------------------------------------------------------------------

type KeyEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'
>

interface KeyContext {
  atStart: boolean
  atEnd: boolean
  isEmpty: boolean
}

interface KeyRule {
  match: (event: KeyEvent, ctx: KeyContext) => boolean
  handle: (event: KeyEvent, callbacks: BlockKeyboardCallbacks, ctx: KeyContext) => void
}

const isMod = (e: KeyEvent): boolean => e.ctrlKey || e.metaKey

/**
 * Ordered rule table. First match wins. Ordering matters: mod-combinations
 * must precede their plain-key equivalents (e.g. `Ctrl+Enter` before `Enter`).
 * Extracted to module scope so `handleBlockKeyDown` stays well under the
 * cognitive-complexity budget.
 */
const KEY_RULES: ReadonlyArray<KeyRule> = [
  // Ctrl/Cmd+Shift+ArrowUp: move block up among siblings
  {
    match: (e) => isMod(e) && e.shiftKey && e.key === 'ArrowUp',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onMoveUp?.()
    },
  },
  // Ctrl/Cmd+Shift+ArrowDown: move block down among siblings
  {
    match: (e) => isMod(e) && e.shiftKey && e.key === 'ArrowDown',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onMoveDown?.()
    },
  },
  // Ctrl/Cmd+Shift+ArrowRight: indent block
  {
    match: (e) => isMod(e) && e.shiftKey && e.key === 'ArrowRight',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onIndent()
    },
  },
  // Ctrl/Cmd+Shift+ArrowLeft: dedent block
  {
    match: (e) => isMod(e) && e.shiftKey && e.key === 'ArrowLeft',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onDedent()
    },
  },
  // Ctrl/Cmd+Enter: toggle task state
  {
    match: (e) => isMod(e) && e.key === 'Enter',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onToggleTodo?.()
    },
  },
  // Ctrl/Cmd+.: toggle collapse/expand children
  {
    match: (e) => isMod(e) && e.key === '.',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onToggleCollapse?.()
    },
  },
  // Configurable shortcut (default Ctrl/Cmd+Shift+P): show properties drawer
  {
    match: (e) => matchesShortcutBinding(e, 'openPropertiesDrawer'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onShowProperties?.()
    },
  },
  // Enter (without Shift): save + create new sibling
  {
    match: (e) => e.key === 'Enter' && !e.shiftKey,
    handle: (e, cb) => {
      e.preventDefault()
      cb.onEnterSave()
    },
  },
  // Escape: cancel editing, discard changes
  {
    match: (e) => e.key === 'Escape',
    handle: (e, cb) => {
      e.preventDefault()
      cb.onEscapeCancel()
    },
  },
  // ArrowUp / ArrowLeft at position 0 → previous block (suppressed when popup open)
  {
    match: (e, ctx) =>
      (e.key === 'ArrowUp' || e.key === 'ArrowLeft') && ctx.atStart && !isSuggestionPopupVisible(),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onFocusPrev()
    },
  },
  // ArrowDown / ArrowRight at end → next block (suppressed when popup open)
  {
    match: (e, ctx) =>
      (e.key === 'ArrowDown' || e.key === 'ArrowRight') && ctx.atEnd && !isSuggestionPopupVisible(),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onFocusNext()
    },
  },
  // Backspace on empty block → delete block (unless sole remaining block)
  {
    match: (e, ctx) => e.key === 'Backspace' && ctx.isEmpty,
    handle: (e, cb) => {
      e.preventDefault()
      if (cb.isLastBlock?.()) return
      cb.onDeleteBlock({ cursorPlacement: 'end' })
    },
  },
  // Backspace at start of non-empty block → merge with previous (p2-t11)
  {
    match: (e, ctx) => e.key === 'Backspace' && ctx.atStart && !ctx.isEmpty,
    handle: (e, cb) => {
      e.preventDefault()
      cb.onMergeWithPrev()
    },
  },
]

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
    isLastBlock,
  } = callbacks

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!editor) return

      // When a suggestion popup is visible, let Enter, Escape, and
      // Backspace pass through to ProseMirror so the Suggestion plugin can
      // handle them: Enter → select item, Escape → dismiss popup,
      // Backspace → delete query character (not merge blocks).
      // (Tab also passes through naturally since it's no longer intercepted.)
      if (
        (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Backspace') &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (isSuggestionPopupVisible()) return // let ProseMirror / Suggestion plugin handle it
      }

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
        isLastBlock,
      })
      // When our handler called preventDefault(), also stop propagation so
      // ProseMirror's keydown handler on the editor DOM doesn't process the
      // same key (e.g. Enter creating an unwanted paragraph).
      if (event.defaultPrevented) {
        event.stopPropagation()
      }
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
      isLastBlock,
    ],
  )

  useEffect(() => {
    if (!editor) return

    let listenerCleanup: (() => void) | undefined

    const attach = () => {
      listenerCleanup?.()
      listenerCleanup = undefined

      let dom: HTMLElement
      try {
        dom = editor.view.dom
      } catch {
        // EditorContent hasn't mounted yet — view.dom throws in TipTap v3
        // when the underlying EditorView doesn't exist.  The 'mount' listener
        // below will retry once the view is ready.
        return
      }
      // Attach on the parent element with capture:true so our handler fires
      // BEFORE ProseMirror's keydown handler (which is on dom itself in the
      // bubble phase). Without this, ProseMirror processes Enter first and
      // inserts a paragraph before we can intercept it.
      const container = dom.parentElement
      if (!container) return
      container.addEventListener('keydown', handleKeyDown, true)
      listenerCleanup = () => container.removeEventListener('keydown', handleKeyDown, true)
    }

    attach()
    editor.on('mount', attach)

    return () => {
      editor.off('mount', attach)
      listenerCleanup?.()
    }
  }, [editor, handleKeyDown])
}
