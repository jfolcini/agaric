/**
 * useBlockKeyboard — keyboard boundary handling for the roving editor.
 *
 * ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block.
 * Backspace on empty → delete block + focus prev. Enter → create new sibling.
 * Ctrl/Cmd+Shift+ArrowRight → indent. Ctrl/Cmd+Shift+ArrowLeft → dedent.
 */

import type { Editor } from '@tiptap/core'
import { useCallback, useEffect } from 'react'

import { isTabIndentEnabled } from '../lib/editor-preferences'
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

/**
 * #907 — is an inline `{{query …}}` ghost-text hint currently on screen?
 *
 * The QueryHint extension (src/editor/extensions/query-hint.ts) renders its
 * completion as a `.query-hint` widget decoration and accepts it on Tab via
 * the editor's own ProseMirror `handleKeyDown`. But this block-level handler
 * is attached capture-phase (see the `attach()` comment below), so it runs
 * BEFORE ProseMirror and — with Tab-indent enabled — would dedent/indent the
 * block before the hint plugin ever sees the Tab. Let Tab fall through while a
 * hint is active so the ghost text is accepted instead. Mirrors the
 * `isSuggestionPopupVisible()` guard but for the popup-less ghost hint.
 *
 * Crucially this gates ONLY Tab. Enter is never routed through here — the
 * hint plugin doesn't render a `.suggestion-popup`, so `isSuggestionPopupVisible`
 * stays false and Enter always reaches `onEnterSave`.
 */
function isQueryHintActive(): boolean {
  const hint = document.querySelector('.query-hint') as HTMLElement | null
  if (!hint || !hint.isConnected) return false
  return typeof hint.checkVisibility === 'function'
    ? hint.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : hint.offsetParent !== null
}

export interface DeleteBlockOpts {
  /**
   * Where to place the cursor when deletion focuses the PREVIOUS block
   * (#752 — forwarded to `RovingEditorHandle.mount`'s `cursorPlacement`).
   * When deletion focuses the next block instead (first block deleted),
   * the default placement applies.
   */
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
  /** Show block history drawer (#976 item 15 — default Ctrl/Cmd+Shift+Y). */
  onShowHistory?: (() => void) | undefined
  /** Duplicate the current block + its subtree (#976 item 13 — default Ctrl/Cmd+Shift+J). */
  onDuplicate?: (() => void) | undefined
  /** Open the "Turn into" type picker for the current block (#976 item 14 — default Ctrl/Cmd+Shift+T). */
  onTurnInto?: (() => void) | undefined
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
  /**
   * Node-type probe (TipTap's `Editor.isActive(name)`). Optional so plain
   * test doubles keep working — when absent, the selection is assumed to be
   * in a plain text block (#725 guards disabled).
   */
  isActive?: (name: string) => boolean
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
    // #725 — node-type guards: inside a code block or table, Enter must
    // insert a newline/paragraph (ProseMirror's newlineInCode / splitBlock)
    // instead of flushing the block, and Backspace must defer to the node's
    // own handling (e.g. CodeBlock's clear-on-empty) instead of deleting or
    // merging the whole block.
    inCodeBlock: editor.isActive?.('codeBlock') ?? false,
    inTable: editor.isActive?.('table') ?? false,
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
  /** Selection is inside a code block (#725 — Enter/Backspace guards). */
  inCodeBlock: boolean
  /** Selection is inside a table (#725 — Enter/Backspace guards). */
  inTable: boolean
}

interface KeyRule {
  match: (event: KeyEvent, ctx: KeyContext) => boolean
  handle: (event: KeyEvent, callbacks: BlockKeyboardCallbacks, ctx: KeyContext) => void
}

/**
 * Ordered rule table. First match wins. Ordering matters: mod-combinations
 * must precede their plain-key equivalents (e.g. `Ctrl+Enter` before `Enter`).
 * Extracted to module scope so `handleBlockKeyDown` stays well under the
 * cognitive-complexity budget.
 */
const KEY_RULES: ReadonlyArray<KeyRule> = [
  // The chord rules below are routed through `matchesShortcutBinding`
  // (#724) so Settings rebinds are honoured. The positional rules further
  // down (Enter / Backspace / boundary arrows) stay hardcoded — their
  // semantics are inseparable from those keys and the catalog marks them
  // `rebindable: false`.
  // `moveBlockUp` (default Ctrl/Cmd+Shift+ArrowUp): move block up among siblings
  {
    match: (e) => matchesShortcutBinding(e, 'moveBlockUp'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onMoveUp?.()
    },
  },
  // `moveBlockDown` (default Ctrl/Cmd+Shift+ArrowDown): move block down among siblings
  {
    match: (e) => matchesShortcutBinding(e, 'moveBlockDown'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onMoveDown?.()
    },
  },
  // `indentBlock` (default Ctrl/Cmd+Shift+ArrowRight): indent block
  {
    match: (e) => matchesShortcutBinding(e, 'indentBlock'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onIndent()
    },
  },
  // `dedentBlock` (default Ctrl/Cmd+Shift+ArrowLeft): dedent block
  {
    match: (e) => matchesShortcutBinding(e, 'dedentBlock'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onDedent()
    },
  },
  // Tab / Shift+Tab: indent / dedent the current block (#912). Tab is the
  // universal outliner restructure key (Logseq, Workflowy, Roam, Notion);
  // Ctrl/Cmd+Shift+Arrow above is the secondary alias. When a suggestion
  // popup is open the hook defers Tab to the Suggestion plugin (Tab-to-accept)
  // BEFORE this rule is reached, so this fires only for plain block editing.
  {
    match: (e) => e.key === 'Tab' && !e.shiftKey,
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onIndent()
    },
  },
  {
    match: (e) => e.key === 'Tab' && e.shiftKey,
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onDedent()
    },
  },
  // `cycleTaskState` (default Ctrl/Cmd+Enter): toggle task state
  {
    match: (e) => matchesShortcutBinding(e, 'cycleTaskState'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onToggleTodo?.()
    },
  },
  // `collapseExpand` (default Ctrl/Cmd+.): toggle collapse/expand children
  {
    match: (e) => matchesShortcutBinding(e, 'collapseExpand'),
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
  // #976 (item 15) — configurable shortcut (default Ctrl/Cmd+Shift+Y): show the
  // block-specific history drawer, mirroring the properties-drawer rule above.
  {
    match: (e) => matchesShortcutBinding(e, 'openBlockHistory'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onShowHistory?.()
    },
  },
  // #976 (item 13) — configurable shortcut (default Ctrl/Cmd+Shift+J): duplicate
  // the focused block + its subtree, reusing the same `handleDuplicate` the
  // context-menu "Duplicate" row and the `/duplicate` slash command fire.
  {
    match: (e) => matchesShortcutBinding(e, 'duplicateBlock'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onDuplicate?.()
    },
  },
  // #976 (item 14) — configurable shortcut (default Ctrl/Cmd+Shift+T): open the
  // "Turn into" type picker for the focused block (surfaces the same conversion
  // family as the context-menu submenu and the `/turn` slash command).
  {
    match: (e) => matchesShortcutBinding(e, 'turnIntoBlock'),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onTurnInto?.()
    },
  },
  // Enter (without Shift): save + create new sibling. Suppressed inside
  // code blocks and tables (#725) so ProseMirror's own Enter handling runs
  // instead (newlineInCode inserts a newline in the fence; splitBlock adds a
  // paragraph in the table cell). Exiting those nodes still works via
  // Escape / ArrowDown-at-end.
  {
    match: (e, ctx) => e.key === 'Enter' && !e.shiftKey && !ctx.inCodeBlock && !ctx.inTable,
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
  // ArrowUp / ArrowLeft at position 0 → previous block (suppressed when popup open).
  // #910 — `!e.shiftKey`: Shift+Arrow at a boundary must EXTEND the selection
  // (let ProseMirror/the browser handle it), not navigate to the adjacent block
  // and silently drop the selection. Plain Arrow still moves block focus.
  // #921 — `!ctrlKey && !metaKey && !altKey`: word/line-wise motion
  // (Ctrl/Alt+Arrow, Cmd+Arrow) must defer to native caret movement rather than
  // jumping to the adjacent block.
  {
    match: (e, ctx) =>
      (e.key === 'ArrowUp' || e.key === 'ArrowLeft') &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      ctx.atStart &&
      !isSuggestionPopupVisible(),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onFocusPrev()
    },
  },
  // ArrowDown / ArrowRight at end → next block (suppressed when popup open).
  // #910 — `!e.shiftKey`; #921 — `!ctrlKey && !metaKey && !altKey`: see the
  // ArrowUp/ArrowLeft rule above (Shift extends selection; word/line modifiers
  // defer to native caret motion instead of jumping to the next block).
  {
    match: (e, ctx) =>
      (e.key === 'ArrowDown' || e.key === 'ArrowRight') &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      ctx.atEnd &&
      !isSuggestionPopupVisible(),
    handle: (e, cb) => {
      e.preventDefault()
      cb.onFlush()
      cb.onFocusNext()
    },
  },
  // Backspace on empty block → delete block (unless sole remaining block).
  // Suppressed inside code blocks/tables (#725): an "empty" code block or
  // table should be unwrapped/edited by ProseMirror's Backspace handling
  // (e.g. CodeBlock clears itself back to a paragraph), not deleted whole.
  {
    match: (e, ctx) => e.key === 'Backspace' && ctx.isEmpty && !ctx.inCodeBlock && !ctx.inTable,
    handle: (e, cb) => {
      e.preventDefault()
      if (cb.isLastBlock?.()) return
      cb.onDeleteBlock({ cursorPlacement: 'end' })
    },
  },
  // Backspace at start of non-empty block → merge with previous (p2-t11).
  // Suppressed inside code blocks/tables (#725): merging a fence/table into
  // the previous block as raw text mangles its markdown.
  {
    match: (e, ctx) =>
      e.key === 'Backspace' && ctx.atStart && !ctx.isEmpty && !ctx.inCodeBlock && !ctx.inTable,
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
    onShowHistory,
    onDuplicate,
    onTurnInto,
    isLastBlock,
  } = callbacks

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!editor) return

      // IME / composition guard: while a CJK (or other) input-method
      // candidate is open, Enter confirms the candidate, Backspace/Arrows
      // navigate it, etc. Intercepting those here would split/merge/navigate
      // blocks instead of editing the composition. Defer entirely to the
      // browser + ProseMirror until the composition commits. `keyCode === 229`
      // is the legacy signal for engines that don't set `isComposing`.
      if (event.isComposing || event.keyCode === 229) return

      // When a suggestion popup is visible, let Enter, Escape, and
      // Backspace pass through to ProseMirror so the Suggestion plugin can
      // handle them: Enter → select item, Escape → dismiss popup,
      // Backspace → delete query character (not merge blocks).
      if (
        (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Backspace') &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (isSuggestionPopupVisible()) return // let ProseMirror / Suggestion plugin handle it
      }

      // #912 — Tab now indents/dedents blocks. Two reasons to let Tab pass
      // through to the browser/ProseMirror untouched:
      //   1. A suggestion popup is open → defer to the Suggestion plugin's
      //      Tab-to-accept instead of restructuring the outline.
      //   2. The accessibility opt-out is OFF → restore Tab as the focus-
      //      navigation key for keyboard/AT users (indent stays on
      //      Ctrl/Cmd+Shift+Arrow). See `isTabIndentEnabled`.
      if (
        event.key === 'Tab' &&
        (isSuggestionPopupVisible() || isQueryHintActive() || !isTabIndentEnabled())
      )
        return

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
        onShowHistory,
        onDuplicate,
        onTurnInto,
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
      onShowHistory,
      onDuplicate,
      onTurnInto,
      isLastBlock,
    ],
  )

  // #915 — `beforeinput` fallback for IMEs (notably Android Gboard) that report
  // `keyCode === 229` for Enter/Backspace, so `handleKeyDown` bails before the
  // KEY_RULES run and block create/delete/merge never fires. `beforeinput`
  // carries a reliable semantic `inputType` independent of the keyCode quirk.
  //
  // No double-fire on desktop: when `handleKeyDown` handles a key it calls
  // `preventDefault()`, which suppresses the subsequent `beforeinput`. This
  // handler therefore only acts when keydown bailed (the Gboard path) or for
  // input the key rules intentionally don't own (mid-text backspace → defer to
  // ProseMirror). Genuine IME composition produces `insertCompositionText` /
  // sets `isComposing`, never `insertParagraph`, so composition is unaffected.
  const handleBeforeInput = useCallback(
    (event: InputEvent) => {
      if (!editor) return
      if (event.isComposing) return

      const it = event.inputType
      if (it !== 'insertParagraph' && it !== 'deleteContentBackward') return

      // Defer to the Suggestion plugin while its popup is open (Enter selects an
      // item, Backspace edits the query) — mirrors the keydown popup guard.
      if (isSuggestionPopupVisible()) return

      // Inside a code block / table, Enter and Backspace belong to ProseMirror
      // (newline in the fence, paragraph/cell edits) — same #725 guard as keydown.
      if ((editor.isActive?.('codeBlock') ?? false) || (editor.isActive?.('table') ?? false)) return

      const { from, empty } = editor.state.selection
      const atStart = from <= 1 && empty

      if (it === 'insertParagraph') {
        event.preventDefault()
        onEnterSave()
        return
      }

      // deleteContentBackward: only the block-structural cases. Mid-text
      // backspace falls through (no preventDefault) so ProseMirror deletes the
      // character normally.
      if (editor.isEmpty) {
        event.preventDefault()
        if (isLastBlock?.()) return
        onDeleteBlock({ cursorPlacement: 'end' })
      } else if (atStart) {
        event.preventDefault()
        onMergeWithPrev()
      }
    },
    [editor, onEnterSave, onDeleteBlock, onMergeWithPrev, isLastBlock],
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
      // #915 — `beforeinput` fires on the contenteditable itself; capture:true
      // keeps us ahead of ProseMirror's own input handling.
      dom.addEventListener('beforeinput', handleBeforeInput as EventListener, true)
      listenerCleanup = () => {
        container.removeEventListener('keydown', handleKeyDown, true)
        dom.removeEventListener('beforeinput', handleBeforeInput as EventListener, true)
      }
    }

    attach()
    editor.on('mount', attach)

    return () => {
      // Don't touch a destroyed editor — `editor.off()` on a torn-down editor
      // can no-op and leak the 'mount' listener across destroy/recreate
      // cycles (#1017). The issue cited `editor.view?.isDestroyed`
      // (suggestion-renderer.ts:199's pattern), but in TipTap v3 `editor.view`
      // is a Proxy stub once the editor is destroyed (`editorView` is null) and
      // its `isDestroyed` reports `false` — so that check misses the
      // `editor.destroy()`-before-cleanup case this bug is about. `Editor.
      // isDestroyed` is the correct signal: it returns `editorView?.isDestroyed
      // ?? true`, covering BOTH a destroyed ProseMirror view and a fully
      // destroyed editor. The DOM listeners were attached to the (now-gone)
      // view's container, so they are released with it; on a live editor we
      // still run `listenerCleanup` to detach them.
      if (editor.isDestroyed) return
      editor.off('mount', attach)
      listenerCleanup?.()
    }
  }, [editor, handleKeyDown, handleBeforeInput])
}
