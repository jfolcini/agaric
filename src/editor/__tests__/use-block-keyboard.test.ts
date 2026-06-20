import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type BlockKeyboardCallbacks,
  type DeleteBlockOpts,
  type EditorLike,
  handleBlockKeyDown,
  useBlockKeyboard,
} from '../use-block-keyboard'

// -- Helpers ------------------------------------------------------------------

function makeEditor(
  overrides: Partial<{
    from: number
    to: number
    selectionEmpty: boolean
    docSize: number
    isEmpty: boolean
  }>,
): EditorLike {
  const { from = 5, to = 5, selectionEmpty = true, docSize = 20, isEmpty = false } = overrides
  return {
    state: {
      selection: { from, to, empty: selectionEmpty },
      doc: { content: { size: docSize } },
    },
    isEmpty,
  }
}

function makeCallbacks(overrides: { isLastBlock?: () => boolean } = {}): BlockKeyboardCallbacks & {
  _calls: Record<string, number>
  _deleteBlockArgs: DeleteBlockOpts[]
} {
  const _calls: Record<string, number> = {}
  const _deleteBlockArgs: DeleteBlockOpts[] = []
  const track = (name: string) => () => {
    _calls[name] = (_calls[name] ?? 0) + 1
  }
  return {
    onFocusPrev: track('onFocusPrev'),
    onFocusNext: track('onFocusNext'),
    onDeleteBlock: (opts: DeleteBlockOpts) => {
      _calls['onDeleteBlock'] = (_calls['onDeleteBlock'] ?? 0) + 1
      _deleteBlockArgs.push(opts)
    },
    onIndent: track('onIndent'),
    onDedent: track('onDedent'),
    onFlush: () => {
      _calls['onFlush'] = (_calls['onFlush'] ?? 0) + 1
      return null
    },
    onMergeWithPrev: track('onMergeWithPrev'),
    onEnterSave: track('onEnterSave'),
    onEscapeCancel: track('onEscapeCancel'),
    onMoveUp: track('onMoveUp'),
    onMoveDown: track('onMoveDown'),
    onToggleTodo: track('onToggleTodo'),
    onToggleCollapse: track('onToggleCollapse'),
    onShowProperties: track('onShowProperties'),
    onShowHistory: track('onShowHistory'),
    onDuplicate: track('onDuplicate'),
    onTurnInto: track('onTurnInto'),
    isLastBlock: overrides.isLastBlock,
    _calls,
    _deleteBlockArgs,
  }
}

function makeEvent(
  key: string,
  opts: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
): Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'> {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    preventDefault: vi.fn(),
  }
}

// -- Tests --------------------------------------------------------------------

describe('handleBlockKeyDown', () => {
  describe('ArrowUp / ArrowLeft at position 0', () => {
    it('ArrowUp at from=1 calls onFlush + onFocusPrev', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onFocusPrev']).toBe(1)
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })

    it('ArrowLeft at from=0 calls onFlush + onFocusPrev', () => {
      const editor = makeEditor({ from: 0, to: 0, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onFocusPrev']).toBe(1)
    })

    it('ArrowUp at from=1 (with docSize=2 for empty doc) triggers', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusPrev']).toBe(1)
    })

    it('ArrowUp NOT at start does nothing', () => {
      const editor = makeEditor({ from: 5, to: 5, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
      expect(cbs._calls['onFlush']).toBeUndefined()
    })

    it('ArrowLeft with non-empty selection does nothing', () => {
      const editor = makeEditor({ from: 0, to: 5, selectionEmpty: false })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })
  })

  describe('ArrowDown / ArrowRight at end', () => {
    it('ArrowDown at end calls onFlush + onFocusNext', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onFocusNext']).toBe(1)
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })

    it('ArrowRight at end calls onFlush + onFocusNext', () => {
      const editor = makeEditor({ from: 20, to: 20, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onFocusNext']).toBe(1)
    })

    it('ArrowDown NOT at end does nothing', () => {
      const editor = makeEditor({ from: 5, to: 5, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })

    it('ArrowRight with non-empty selection at end does nothing', () => {
      const editor = makeEditor({ from: 15, to: 20, selectionEmpty: false, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })
  })

  // #910 — Shift+Arrow at a block boundary must EXTEND the selection (defer to
  // ProseMirror) instead of navigating to the adjacent block and dropping it.
  describe('Shift+Arrow at a boundary does not navigate (#910)', () => {
    it('Shift+ArrowUp at start does NOT focus the previous block', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })

    it('Shift+ArrowLeft at start does NOT focus the previous block', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })

    it('Shift+ArrowDown at end does NOT focus the next block', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })

    it('Shift+ArrowRight at end does NOT focus the next block', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })
  })

  // #921 — word/line-wise modifiers (Ctrl/Alt+Arrow, Cmd+Arrow) at a boundary
  // must defer to native caret motion, not jump to the adjacent block.
  describe('Ctrl/Meta/Alt+Arrow at a boundary does not navigate (#921)', () => {
    it('Ctrl+ArrowRight at end does NOT focus the next block', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    })

    it('Meta+ArrowLeft at start does NOT focus the previous block', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { metaKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })

    it('Alt+ArrowUp at start does NOT focus the previous block', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { altKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onFocusPrev']).toBeUndefined()
    })

    it('plain ArrowRight at end still focuses the next block (guard not over-broad)', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusNext']).toBe(1)
    })
  })

  describe('Ctrl+Shift+ArrowRight / ArrowLeft (indent / dedent)', () => {
    it('Ctrl+Shift+ArrowRight calls onFlush + onIndent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onIndent']).toBe(1)
      expect(cbs._calls['onDedent']).toBeUndefined()
    })

    it('Ctrl+Shift+ArrowLeft calls onFlush + onDedent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onDedent']).toBe(1)
      expect(cbs._calls['onIndent']).toBeUndefined()
    })

    it('Meta+Shift+ArrowRight calls onIndent (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onIndent']).toBe(1)
    })

    it('Meta+Shift+ArrowLeft calls onDedent (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDedent']).toBe(1)
    })

    // #912 — Tab / Shift+Tab are now the primary outliner indent/dedent keys.
    it('Tab calls onFlush + onIndent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Tab')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onIndent']).toBe(1)
      expect(cbs._calls['onDedent']).toBeUndefined()
    })

    it('Shift+Tab calls onFlush + onDedent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Tab', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onDedent']).toBe(1)
      expect(cbs._calls['onIndent']).toBeUndefined()
    })

    it('Ctrl+ArrowRight without Shift does NOT call onIndent', () => {
      const editor = makeEditor({ from: 5, to: 5 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onIndent']).toBeUndefined()
    })
  })

  describe('Backspace on empty', () => {
    it('Backspace on empty block calls onDeleteBlock with cursorPlacement end', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDeleteBlock']).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
    })

    it('Backspace on non-empty block at middle does nothing', () => {
      const editor = makeEditor({ isEmpty: false, from: 5, to: 5, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onDeleteBlock']).toBeUndefined()
      expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
    })

    it('Backspace on empty does not flush (nothing to flush)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFlush']).toBeUndefined()
    })

    it('Backspace on sole remaining block is a no-op (last-block guard)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks({ isLastBlock: () => true })
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDeleteBlock']).toBeUndefined()
      expect(cbs._deleteBlockArgs).toHaveLength(0)
    })

    it('Backspace on empty block when isLastBlock returns false proceeds with deletion', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks({ isLastBlock: () => false })
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDeleteBlock']).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
    })

    it('Backspace on empty block when isLastBlock is not provided proceeds with deletion', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onDeleteBlock']).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
    })
  })

  describe('Enter / Shift+Enter', () => {
    it('Enter calls onEnterSave', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onEnterSave']).toBe(1)
    })

    // #1172 — `insertLineBreak` (Shift+Enter). The block key handler must NOT
    // claim Shift+Enter: it deliberately falls through (no preventDefault, no
    // onEnterSave) so TipTap's HardBreak extension keymap (`Shift-Enter` →
    // setHardBreak) inserts a soft line break instead of splitting the block.
    // The extension-side wiring is asserted in `use-roving-editor`'s HardBreak
    // coverage; here we pin the fall-through contract.
    it('Shift+Enter does nothing (TipTap default handles line break)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onEnterSave']).toBeUndefined()
    })

    it('Ctrl+Shift+Enter is also left to TipTap (Mod-Enter hard break)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      // HardBreak's other keymap is `Mod-Enter`. The block handler's Enter rule
      // requires a bare Enter (no shift), and Ctrl+Enter is `cycleTaskState`
      // (onToggleTodo). With BOTH ctrl AND shift, neither the Enter-save rule
      // nor the task-cycle rule should fire — it passes through to TipTap.
      const event = makeEvent('Enter', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onEnterSave']).toBeUndefined()
    })
  })

  // #1172 — `openBlockHistory` (#976 item 15, default Ctrl/Cmd+Shift+Y) and
  // `openPropertiesDrawer` (Ctrl/Cmd+Shift+P). These chord rules route through
  // `matchesShortcutBinding` against the default catalog, so the test exercises
  // the real key→action path end to end.
  describe('Block drawers (history / properties)', () => {
    it('Ctrl+Shift+Y calls onShowHistory (openBlockHistory)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Y', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onShowHistory']).toBe(1)
      expect(cbs._calls['onShowProperties']).toBeUndefined()
    })

    it('Meta+Shift+Y calls onShowHistory (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Y', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onShowHistory']).toBe(1)
    })

    it('plain Y does NOT open the history drawer', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Y')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onShowHistory']).toBeUndefined()
    })

    it('Ctrl+Shift+P calls onShowProperties (openPropertiesDrawer)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('P', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onShowProperties']).toBe(1)
      expect(cbs._calls['onShowHistory']).toBeUndefined()
    })
  })

  // #976 (items 13/14) — the duplicate / turn-into block bindings. Like the
  // drawers above, these go through the real `matchesShortcutBinding` catalog
  // path, so the test pins the default key → action mapping end to end.
  describe('Duplicate / Turn into (#976 items 13/14)', () => {
    it('Ctrl+Shift+J calls onDuplicate (duplicateBlock)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('J', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDuplicate']).toBe(1)
      expect(cbs._calls['onTurnInto']).toBeUndefined()
    })

    it('Meta+Shift+J calls onDuplicate (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('J', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onDuplicate']).toBe(1)
    })

    it('plain J does NOT duplicate', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      handleBlockKeyDown(makeEvent('J'), editor, cbs)
      expect(cbs._calls['onDuplicate']).toBeUndefined()
    })

    it('Ctrl+Shift+T calls onTurnInto (turnIntoBlock)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('T', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onTurnInto']).toBe(1)
      expect(cbs._calls['onDuplicate']).toBeUndefined()
    })

    it('Meta+Shift+T calls onTurnInto (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('T', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onTurnInto']).toBe(1)
    })

    it('plain T does NOT open turn-into', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      handleBlockKeyDown(makeEvent('T'), editor, cbs)
      expect(cbs._calls['onTurnInto']).toBeUndefined()
    })
  })

  describe('Escape', () => {
    it('Escape calls onEscapeCancel', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Escape')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onEscapeCancel']).toBe(1)
    })
  })

  describe('unhandled keys', () => {
    it('regular character key does nothing', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('a')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('cursor at both start and end of single-char doc triggers ArrowUp as prev', () => {
      // Doc with one paragraph, one character: positions 0=before-p, 1=before-char, 2=after-char, 3=after-p
      // docSize = 3, so atEnd = to >= 2. With from=1, to=1, atStart=true, atEnd=false
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true, docSize: 3 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusPrev']).toBe(1)
    })

    it('empty doc (docSize=2): cursor at 1 is both at start and end — ArrowDown → next', () => {
      // Empty paragraph: positions 0=before-p, 1=inside-p (cursor), 2=after-p
      // docSize = 2, atStart = 1 <= 1, atEnd = 1 >= 1. Both true!
      // ArrowUp checks first in code order, so ArrowDown should also work
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusNext']).toBe(1)
    })
  })

  describe('Backspace merge with previous (p2-t11)', () => {
    it('Backspace at start of non-empty block calls onMergeWithPrev', () => {
      // Non-empty, cursor at position 1 (start of text), docSize > 2
      const editor = makeEditor({
        isEmpty: false,
        from: 1,
        to: 1,
        selectionEmpty: true,
        docSize: 10,
      })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onMergeWithPrev']).toBe(1)
      expect(cbs._calls['onDeleteBlock']).toBeUndefined()
    })

    it('Backspace at position 0 of non-empty block calls onMergeWithPrev', () => {
      const editor = makeEditor({
        isEmpty: false,
        from: 0,
        to: 0,
        selectionEmpty: true,
        docSize: 10,
      })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onMergeWithPrev']).toBe(1)
    })

    it('Backspace on empty block still calls onDeleteBlock with cursorPlacement end (no regression)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onDeleteBlock']).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
      expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
    })

    it('Backspace in middle of text does NOT trigger merge', () => {
      const editor = makeEditor({
        isEmpty: false,
        from: 5,
        to: 5,
        selectionEmpty: true,
        docSize: 20,
      })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
      expect(cbs._calls['onDeleteBlock']).toBeUndefined()
    })

    it('Backspace at start with selection does NOT trigger merge', () => {
      const editor = makeEditor({
        isEmpty: false,
        from: 1,
        to: 5,
        selectionEmpty: false,
        docSize: 20,
      })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
    })
  })

  describe('Ctrl+Enter (toggle todo)', () => {
    it('Ctrl+Enter calls onToggleTodo', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onToggleTodo']).toBe(1)
      expect(cbs._calls['onEnterSave']).toBeUndefined()
    })

    it('Meta+Enter calls onToggleTodo (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { metaKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onToggleTodo']).toBe(1)
      expect(cbs._calls['onEnterSave']).toBeUndefined()
    })

    it('plain Enter does NOT call onToggleTodo', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onToggleTodo']).toBeUndefined()
      expect(cbs._calls['onEnterSave']).toBe(1)
    })
  })

  describe('Ctrl+. (toggle collapse)', () => {
    it('Ctrl+. calls onToggleCollapse', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onToggleCollapse']).toBe(1)
    })

    it('Meta+. calls onToggleCollapse (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.', { metaKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onToggleCollapse']).toBe(1)
    })

    it('plain . does NOT call onToggleCollapse', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls['onToggleCollapse']).toBeUndefined()
    })
  })

  describe('Ctrl+Shift+Arrow (move block)', () => {
    it('Ctrl+Shift+ArrowUp calls onFlush + onMoveUp', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onMoveUp']).toBe(1)
    })

    it('Ctrl+Shift+ArrowDown calls onFlush + onMoveDown', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onFlush']).toBe(1)
      expect(cbs._calls['onMoveDown']).toBe(1)
    })

    it('Meta+Shift+ArrowUp calls onMoveUp (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onMoveUp']).toBe(1)
    })

    it('Meta+Shift+ArrowDown calls onMoveDown (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls['onMoveDown']).toBe(1)
    })

    it('Ctrl+ArrowUp without Shift does NOT call onMoveUp', () => {
      const editor = makeEditor({ from: 5, to: 5 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onMoveUp']).toBeUndefined()
    })
  })

  describe('arrow keys suppressed when suggestion popup is visible (B-22)', () => {
    afterEach(() => {
      // Clean up any popup elements added to the DOM
      document.querySelectorAll('.suggestion-popup').forEach((el) => {
        el.remove()
      })
    })

    function addVisiblePopup() {
      const popup = document.createElement('div')
      popup.className = 'suggestion-popup'
      // jsdom doesn't implement checkVisibility or offsetParent, so mock it
      popup.checkVisibility = () => true
      document.body.append(popup)
      return popup
    }

    it('ArrowUp at start does NOT switch blocks when popup is visible', () => {
      addVisiblePopup()
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusPrev']).toBeUndefined()
      expect(cbs._calls['onFlush']).toBeUndefined()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('ArrowDown at end does NOT switch blocks when popup is visible', () => {
      addVisiblePopup()
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusNext']).toBeUndefined()
      expect(cbs._calls['onFlush']).toBeUndefined()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('ArrowUp at start switches blocks when popup is absent', () => {
      // No popup added — should work normally
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls['onFocusPrev']).toBe(1)
      expect(cbs._calls['onFlush']).toBe(1)
      expect(event.preventDefault).toHaveBeenCalled()
    })

    // -- useBlockKeyboard hook-level popup-yield (Enter / Escape / Backspace) --
    //
    // Lines 272-284 of use-block-keyboard.ts implement a capture-phase guard
    // that yields to a visible .suggestion-popup for Enter, Escape, and
    // Backspace (AGENTS.md pitfall #14). The arrow-key cases above exercise
    // the same behaviour through `handleBlockKeyDown`; these three cases drive
    // the full hook so the early-return at the top of `handleKeyDown` is
    // covered. Tab is intentionally pass-through (no rule + no early-return),
    // so no Tab case is needed here.
    function setupHookWithRealEditor(opts: { content?: string } = {}) {
      const element = document.createElement('div')
      document.body.append(element)
      const editor = new Editor({
        element,
        extensions: [Document, Paragraph, Text],
        content: opts.content
          ? {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: opts.content }] }],
            }
          : { type: 'doc', content: [{ type: 'paragraph' }] },
      })
      const callbacks = makeCallbacks()
      const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))
      // The hook attaches its listener on editor.view.dom.parentElement with
      // capture:true. Dispatch on the parent itself so ProseMirror's own
      // bubble-phase listener (attached to view.dom, a descendant) never sees
      // the event — that way only the wrapper hook's preventDefault path is
      // observable.
      const target = editor.view.dom.parentElement as HTMLElement
      const cleanup = () => {
        unmount()
        editor.destroy()
        element.remove()
      }
      return { editor, callbacks, target, cleanup }
    }

    it('Enter does NOT trigger onEnterSave when popup is visible (hook-level yield)', () => {
      addVisiblePopup()
      const { callbacks, target, cleanup } = setupHookWithRealEditor()

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

      target.dispatchEvent(event)

      expect(callbacks._calls['onEnterSave']).toBeUndefined()
      expect(preventDefaultSpy).not.toHaveBeenCalled()

      cleanup()
    })

    it('Escape does NOT trigger onEscapeCancel when popup is visible (hook-level yield)', () => {
      addVisiblePopup()
      const { callbacks, target, cleanup } = setupHookWithRealEditor()

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

      target.dispatchEvent(event)

      expect(callbacks._calls['onEscapeCancel']).toBeUndefined()
      expect(preventDefaultSpy).not.toHaveBeenCalled()

      cleanup()
    })

    it('Backspace does NOT trigger onMergeWithPrev / onDeleteBlock at start of empty block when popup is visible (hook-level yield)', () => {
      addVisiblePopup()
      // Empty block — without the popup-yield, the "Backspace on empty"
      // rule would call onDeleteBlock. With the popup-yield, neither
      // onDeleteBlock nor onMergeWithPrev should fire.
      const { editor, callbacks, target, cleanup } = setupHookWithRealEditor()
      expect(editor.isEmpty).toBe(true)

      const event = new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

      target.dispatchEvent(event)

      expect(callbacks._calls['onMergeWithPrev']).toBeUndefined()
      expect(callbacks._calls['onDeleteBlock']).toBeUndefined()
      expect(preventDefaultSpy).not.toHaveBeenCalled()

      cleanup()
    })
  })
})

describe('useBlockKeyboard — IME / composition guard', () => {
  function setup() {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const callbacks = makeCallbacks()
    const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))
    const target = editor.view.dom.parentElement as HTMLElement
    const cleanup = () => {
      unmount()
      editor.destroy()
      element.remove()
    }
    return { callbacks, target, cleanup }
  }

  it('Enter during IME composition does NOT split the block', () => {
    const { callbacks, target, cleanup } = setup()

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    // jsdom doesn't honour `isComposing` from the init dict, so force it on
    // the instance (shadows the prototype getter).
    Object.defineProperty(event, 'isComposing', { value: true })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

    target.dispatchEvent(event)

    expect(callbacks._calls['onEnterSave']).toBeUndefined()
    expect(preventDefaultSpy).not.toHaveBeenCalled()

    cleanup()
  })

  it('Enter outside composition still triggers onEnterSave (guard does not over-fire)', () => {
    const { callbacks, target, cleanup } = setup()

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    target.dispatchEvent(event)

    expect(callbacks._calls['onEnterSave']).toBe(1)

    cleanup()
  })
})

// #912 — accessibility opt-out: when "Tab indents blocks" is OFF, Tab must pass
// through for focus navigation instead of indenting (no keyboard trap).
describe('useBlockKeyboard — Tab-indent accessibility opt-out', () => {
  function setup() {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const callbacks = makeCallbacks()
    const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))
    const target = editor.view.dom.parentElement as HTMLElement
    const cleanup = () => {
      unmount()
      editor.destroy()
      element.remove()
      localStorage.removeItem('agaric-tab-indents-blocks')
    }
    return { callbacks, target, cleanup }
  }

  it('Tab indents by default (preference absent)', () => {
    const { callbacks, target, cleanup } = setup()

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    target.dispatchEvent(event)

    expect(callbacks._calls['onIndent']).toBe(1)
    cleanup()
  })

  it('Tab does NOT indent and is not preventDefault-ed when the opt-out is off', () => {
    localStorage.setItem('agaric-tab-indents-blocks', 'false')
    const { callbacks, target, cleanup } = setup()

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)

    // Tab passes through for browser focus navigation.
    expect(callbacks._calls['onIndent']).toBeUndefined()
    expect(callbacks._calls['onDedent']).toBeUndefined()
    expect(preventDefaultSpy).not.toHaveBeenCalled()
    cleanup()
  })
})

// #915 — `beforeinput` fallback so Android Gboard (keyCode 229) can still
// create/delete/merge blocks even when `handleKeyDown` bails.
describe('useBlockKeyboard — beforeinput fallback (#915)', () => {
  function setup(markdownContent?: string) {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: markdownContent
        ? {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: markdownContent }] }],
          }
        : { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const callbacks = makeCallbacks()
    const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))
    const dom = editor.view.dom as HTMLElement
    const cleanup = () => {
      unmount()
      editor.destroy()
      element.remove()
    }
    return { editor, callbacks, dom, cleanup }
  }

  function fireBeforeInput(dom: HTMLElement, inputType: string) {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
    dom.dispatchEvent(event)
    return preventDefaultSpy
  }

  it('insertParagraph triggers onEnterSave (Gboard Enter)', () => {
    const { callbacks, dom, cleanup } = setup()
    const spy = fireBeforeInput(dom, 'insertParagraph')
    expect(callbacks._calls['onEnterSave']).toBe(1)
    expect(spy).toHaveBeenCalled()
    cleanup()
  })

  it('deleteContentBackward on an empty block triggers onDeleteBlock', () => {
    const { callbacks, dom, cleanup } = setup()
    const spy = fireBeforeInput(dom, 'deleteContentBackward')
    expect(callbacks._calls['onDeleteBlock']).toBe(1)
    expect(spy).toHaveBeenCalled()
    cleanup()
  })

  it('deleteContentBackward at the start of a non-empty block triggers onMergeWithPrev', () => {
    const { editor, callbacks, dom, cleanup } = setup('hello')
    editor.commands.setTextSelection(1) // caret at the very start
    const spy = fireBeforeInput(dom, 'deleteContentBackward')
    expect(callbacks._calls['onMergeWithPrev']).toBe(1)
    expect(spy).toHaveBeenCalled()
    cleanup()
  })

  it('deleteContentBackward mid-text is left to ProseMirror (no callback, no preventDefault)', () => {
    const { editor, callbacks, dom, cleanup } = setup('hello')
    editor.commands.setTextSelection(3) // caret in the middle
    const spy = fireBeforeInput(dom, 'deleteContentBackward')
    expect(callbacks._calls['onMergeWithPrev']).toBeUndefined()
    expect(callbacks._calls['onDeleteBlock']).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
    cleanup()
  })

  it('ignores non-structural input types (insertText)', () => {
    const { callbacks, dom, cleanup } = setup()
    const spy = fireBeforeInput(dom, 'insertText')
    expect(callbacks._calls['onEnterSave']).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
    cleanup()
  })

  it('ignores input while an IME composition is active', () => {
    const { dom, callbacks, cleanup } = setup()
    const event = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'isComposing', { value: true })
    dom.dispatchEvent(event)
    expect(callbacks._calls['onEnterSave']).toBeUndefined()
    cleanup()
  })

  // #925 f1 — the Gboard (Android) path: a Backspace/Enter arrives as a keydown
  // with `keyCode === 229` (the IME sentinel). `handleKeyDown` must BAIL on that
  // keydown (no callback, no preventDefault) so it is the FOLLOWING `beforeinput`
  // — which carries a reliable semantic `inputType` — that drives the structural
  // delete/merge/split. These tests assert both halves of the documented
  // contract: keydown swallowed, beforeinput acts.
  function fireKeydown(target: HTMLElement, key: string, extra?: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
    target.dispatchEvent(event)
    return preventDefaultSpy
  }

  it('keyCode-229 Backspace keydown is swallowed; beforeinput drives the delete (empty block)', () => {
    const { callbacks, dom, cleanup } = setup()
    const container = dom.parentElement as HTMLElement

    // 1. The Gboard keydown (keyCode 229) bails before KEY_RULES run: no
    //    callback fires and the event is NOT preventDefault-ed (so the browser
    //    still emits the matching `beforeinput`).
    const keydownSpy = fireKeydown(container, 'Backspace', { keyCode: 229 })
    expect(callbacks._calls['onDeleteBlock']).toBeUndefined()
    expect(keydownSpy).not.toHaveBeenCalled()

    // 2. The follow-up beforeinput (deleteContentBackward) is what actually
    //    drives the block delete on an empty block.
    const beforeInputSpy = fireBeforeInput(dom, 'deleteContentBackward')
    expect(callbacks._calls['onDeleteBlock']).toBe(1)
    expect(beforeInputSpy).toHaveBeenCalled()
    cleanup()
  })

  it('keyCode-229 Backspace keydown is swallowed; beforeinput drives the merge (start of non-empty block)', () => {
    const { editor, callbacks, dom, cleanup } = setup('hello')
    editor.commands.setTextSelection(1) // caret at the very start
    const container = dom.parentElement as HTMLElement

    const keydownSpy = fireKeydown(container, 'Backspace', { keyCode: 229 })
    expect(callbacks._calls['onMergeWithPrev']).toBeUndefined()
    expect(keydownSpy).not.toHaveBeenCalled()

    const beforeInputSpy = fireBeforeInput(dom, 'deleteContentBackward')
    expect(callbacks._calls['onMergeWithPrev']).toBe(1)
    expect(beforeInputSpy).toHaveBeenCalled()
    cleanup()
  })

  it('keyCode-229 Enter keydown is swallowed; beforeinput drives the split (insertParagraph)', () => {
    const { callbacks, dom, cleanup } = setup()
    const container = dom.parentElement as HTMLElement

    const keydownSpy = fireKeydown(container, 'Enter', { keyCode: 229 })
    expect(callbacks._calls['onEnterSave']).toBeUndefined()
    expect(keydownSpy).not.toHaveBeenCalled()

    const beforeInputSpy = fireBeforeInput(dom, 'insertParagraph')
    expect(callbacks._calls['onEnterSave']).toBe(1)
    expect(beforeInputSpy).toHaveBeenCalled()
    cleanup()
  })
})

// -- #725: Enter/Backspace inside code blocks and tables ------------------------
//
// The Enter rule used to fire unconditionally on the capture-phase listener,
// so ProseMirror's `newlineInCode` (code blocks) and `splitBlock` (table
// cells) never ran — pressing Enter inside a fence flushed the whole block.
// These tests drive BOTH halves of the pipeline with a REAL editor:
//   1. `handleBlockKeyDown` (the capture-phase wrapper) must NOT intercept,
//   2. the key dispatched through the editor's real ProseMirror keymap
//      (`view.someProp('handleKeyDown', …)` — the #752 pattern) must insert
//      a newline / paragraph inside the node.

describe('#725 — node-type guards (code block / table)', () => {
  const lowlight = createLowlight(common)

  /** Run a keydown through the editor's ProseMirror keymap plugins. */
  function dispatchKeydown(ed: Editor, key: string): boolean {
    return (
      ed.view.someProp('handleKeyDown', (handler) =>
        handler(ed.view, new KeyboardEvent('keydown', { key })),
      ) ?? false
    )
  }

  function makeCodeBlockEditor(codeText: string): { editor: Editor; cleanup: () => void } {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, CodeBlockLowlight.configure({ lowlight })],
      content: {
        type: 'doc',
        content: [
          codeText.length > 0
            ? { type: 'codeBlock', content: [{ type: 'text', text: codeText }] }
            : { type: 'codeBlock' },
        ],
      },
    })
    return {
      editor,
      cleanup: () => {
        editor.destroy()
        element.remove()
      },
    }
  }

  function makeTableEditor(): { editor: Editor; cleanup: () => void } {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, Table, TableRow, TableHeader, TableCell],
      content: {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell one' }] }],
                  },
                  {
                    type: 'tableCell',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell two' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    return {
      editor,
      cleanup: () => {
        editor.destroy()
        element.remove()
      },
    }
  }

  describe('Enter inside a code block', () => {
    it('is NOT intercepted by the block rule and inserts a newline via the real keymap', () => {
      const { editor, cleanup } = makeCodeBlockEditor('const x = 1')
      try {
        // Caret at the end of the code text (inside the fence).
        editor.commands.setTextSelection(1 + 'const x = 1'.length)
        expect(editor.isActive('codeBlock')).toBe(true)

        // 1. Capture-phase wrapper: must yield (no flush, no preventDefault).
        const cbs = makeCallbacks()
        const event = makeEvent('Enter')
        handleBlockKeyDown(event, editor, cbs)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(cbs._calls['onEnterSave']).toBeUndefined()

        // 2. Real ProseMirror keymap: newlineInCode handles Enter.
        expect(dispatchKeydown(editor, 'Enter')).toBe(true)
        expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock')
        expect(editor.state.doc.firstChild?.textContent).toBe('const x = 1\n')
        // Still a single block — nothing was split or flushed.
        expect(editor.state.doc.childCount).toBe(1)
      } finally {
        cleanup()
      }
    })

    it('mid-text Enter inserts the newline at the caret', () => {
      const { editor, cleanup } = makeCodeBlockEditor('ab')
      try {
        editor.commands.setTextSelection(2) // between a and b
        const cbs = makeCallbacks()
        handleBlockKeyDown(makeEvent('Enter'), editor, cbs)
        expect(cbs._calls['onEnterSave']).toBeUndefined()
        expect(dispatchKeydown(editor, 'Enter')).toBe(true)
        expect(editor.state.doc.firstChild?.textContent).toBe('a\nb')
      } finally {
        cleanup()
      }
    })

    it('Backspace at the start of a code block does NOT merge with the previous block', () => {
      const { editor, cleanup } = makeCodeBlockEditor('const x = 1')
      try {
        editor.commands.setTextSelection(1) // start of the code text → ctx.atStart
        const cbs = makeCallbacks()
        const event = makeEvent('Backspace')
        handleBlockKeyDown(event, editor, cbs)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
        expect(cbs._calls['onDeleteBlock']).toBeUndefined()
      } finally {
        cleanup()
      }
    })

    it('Backspace in an EMPTY code block defers to ProseMirror (clears the fence, not the block)', () => {
      const { editor, cleanup } = makeCodeBlockEditor('')
      try {
        editor.commands.setTextSelection(1)
        expect(editor.isEmpty).toBe(true) // would have matched the delete-block rule
        const cbs = makeCallbacks()
        const event = makeEvent('Backspace')
        handleBlockKeyDown(event, editor, cbs)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(cbs._calls['onDeleteBlock']).toBeUndefined()
        // The real keymap converts the empty fence back to a paragraph.
        expect(dispatchKeydown(editor, 'Backspace')).toBe(true)
        expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
      } finally {
        cleanup()
      }
    })
  })

  describe('Enter inside a table', () => {
    it('is NOT intercepted by the block rule and adds a paragraph in the cell via the real keymap', () => {
      const { editor, cleanup } = makeTableEditor()
      try {
        // Place the caret inside the first cell's text.
        const cellOnePos = 5 // doc(0) table(1) row(2) cell(3) para(4) text(5…)
        editor.commands.setTextSelection(cellOnePos + 'cell one'.length)
        expect(editor.isActive('table')).toBe(true)

        // 1. Capture-phase wrapper must yield.
        const cbs = makeCallbacks()
        const event = makeEvent('Enter')
        handleBlockKeyDown(event, editor, cbs)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(cbs._calls['onEnterSave']).toBeUndefined()

        // 2. Real keymap: splitBlock adds a second paragraph INSIDE the cell.
        expect(dispatchKeydown(editor, 'Enter')).toBe(true)
        const cell = editor.state.doc.firstChild?.firstChild?.firstChild
        expect(cell?.type.name).toBe('tableCell')
        expect(cell?.childCount).toBe(2)
        // The table itself is intact (single top-level block).
        expect(editor.state.doc.childCount).toBe(1)
        expect(editor.state.doc.firstChild?.type.name).toBe('table')
      } finally {
        cleanup()
      }
    })
  })

  describe('plain paragraphs are unaffected (control)', () => {
    it('Enter in a paragraph still flushes via onEnterSave (real editor)', () => {
      const element = document.createElement('div')
      document.body.append(element)
      const editor = new Editor({
        element,
        extensions: [Document, Paragraph, Text],
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
        },
      })
      try {
        editor.commands.setTextSelection(3)
        const cbs = makeCallbacks()
        const event = makeEvent('Enter')
        handleBlockKeyDown(event, editor, cbs)
        expect(event.preventDefault).toHaveBeenCalledOnce()
        expect(cbs._calls['onEnterSave']).toBe(1)
      } finally {
        editor.destroy()
        element.remove()
      }
    })

    it('mock editors without isActive keep the legacy behaviour (guards default off)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      handleBlockKeyDown(makeEvent('Enter'), editor, cbs)
      expect(cbs._calls['onEnterSave']).toBe(1)
    })

    it('mock editor reporting codeBlock suppresses Enter and Backspace rules', () => {
      const editor: EditorLike = {
        ...makeEditor({ from: 1, to: 1, isEmpty: true }),
        isActive: (name: string) => name === 'codeBlock',
      }
      const cbs = makeCallbacks()
      handleBlockKeyDown(makeEvent('Enter'), editor, cbs)
      handleBlockKeyDown(makeEvent('Backspace'), editor, cbs)
      expect(cbs._calls['onEnterSave']).toBeUndefined()
      expect(cbs._calls['onDeleteBlock']).toBeUndefined()
      expect(cbs._calls['onMergeWithPrev']).toBeUndefined()
    })
  })
})

// =========================================================================
// #1017 (C3): the effect cleanup must not touch a destroyed editor — calling
// editor.off('mount', attach) on a torn-down view can no-op and leak the
// 'mount' listener. The cleanup guards on `editor.isDestroyed` (which returns
// `editorView?.isDestroyed ?? true`) — NOT `editor.view?.isDestroyed`, because
// in TipTap v3 `editor.view` becomes a Proxy stub reporting `isDestroyed: false`
// after destroy, so that check would miss the destroy-before-cleanup case.
// =========================================================================

describe('useBlockKeyboard — cleanup on a destroyed editor (#1017)', () => {
  it('does not throw and skips editor.off() when the editor was destroyed before cleanup', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const offSpy = vi.spyOn(editor, 'off')

    const callbacks = makeCallbacks()
    const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))

    // Destroy the editor BEFORE React runs the effect cleanup (mirrors a
    // concurrent-render / exception-recovery teardown order). NB: in TipTap
    // v3 `editor.view` becomes a Proxy stub reporting `isDestroyed: false`
    // after destroy; `editor.isDestroyed` is the reliable signal (it returns
    // `editorView?.isDestroyed ?? true`), which is what the cleanup guards on.
    editor.destroy()
    expect(editor.isDestroyed).toBe(true)

    // Effect cleanup runs here — must early-return on the destroyed view.
    expect(() => unmount()).not.toThrow()
    expect(offSpy).not.toHaveBeenCalled()

    offSpy.mockRestore()
    element.remove()
  })

  it('still detaches the mount listener when the editor is alive at cleanup', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const offSpy = vi.spyOn(editor, 'off')

    const callbacks = makeCallbacks()
    const { unmount } = renderHook(() => useBlockKeyboard(editor, callbacks))

    // Live editor at cleanup → the 'mount' listener is removed normally.
    unmount()
    expect(offSpy).toHaveBeenCalledWith('mount', expect.any(Function))

    offSpy.mockRestore()
    editor.destroy()
    element.remove()
  })
})
