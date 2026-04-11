import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type BlockKeyboardCallbacks,
  type DeleteBlockOpts,
  type EditorLike,
  handleBlockKeyDown,
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
      _calls.onDeleteBlock = (_calls.onDeleteBlock ?? 0) + 1
      _deleteBlockArgs.push(opts)
    },
    onIndent: track('onIndent'),
    onDedent: track('onDedent'),
    onFlush: () => {
      _calls.onFlush = (_calls.onFlush ?? 0) + 1
      return null
    },
    onMergeWithPrev: track('onMergeWithPrev'),
    onEnterSave: track('onEnterSave'),
    onEscapeCancel: track('onEscapeCancel'),
    onMoveUp: track('onMoveUp'),
    onMoveDown: track('onMoveDown'),
    onToggleTodo: track('onToggleTodo'),
    onToggleCollapse: track('onToggleCollapse'),
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
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onFocusPrev).toBe(1)
      expect(cbs._calls.onFocusNext).toBeUndefined()
    })

    it('ArrowLeft at from=0 calls onFlush + onFocusPrev', () => {
      const editor = makeEditor({ from: 0, to: 0, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onFocusPrev).toBe(1)
    })

    it('ArrowUp at from=1 (with docSize=2 for empty doc) triggers', () => {
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFocusPrev).toBe(1)
    })

    it('ArrowUp NOT at start does nothing', () => {
      const editor = makeEditor({ from: 5, to: 5, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onFocusPrev).toBeUndefined()
      expect(cbs._calls.onFlush).toBeUndefined()
    })

    it('ArrowLeft with non-empty selection does nothing', () => {
      const editor = makeEditor({ from: 0, to: 5, selectionEmpty: false })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onFocusPrev).toBeUndefined()
    })
  })

  describe('ArrowDown / ArrowRight at end', () => {
    it('ArrowDown at end calls onFlush + onFocusNext', () => {
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onFocusNext).toBe(1)
      expect(cbs._calls.onFocusPrev).toBeUndefined()
    })

    it('ArrowRight at end calls onFlush + onFocusNext', () => {
      const editor = makeEditor({ from: 20, to: 20, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onFocusNext).toBe(1)
    })

    it('ArrowDown NOT at end does nothing', () => {
      const editor = makeEditor({ from: 5, to: 5, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onFocusNext).toBeUndefined()
    })

    it('ArrowRight with non-empty selection at end does nothing', () => {
      const editor = makeEditor({ from: 15, to: 20, selectionEmpty: false, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onFocusNext).toBeUndefined()
    })
  })

  describe('Ctrl+Shift+ArrowRight / ArrowLeft (indent / dedent)', () => {
    it('Ctrl+Shift+ArrowRight calls onFlush + onIndent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onIndent).toBe(1)
      expect(cbs._calls.onDedent).toBeUndefined()
    })

    it('Ctrl+Shift+ArrowLeft calls onFlush + onDedent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onDedent).toBe(1)
      expect(cbs._calls.onIndent).toBeUndefined()
    })

    it('Meta+Shift+ArrowRight calls onIndent (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onIndent).toBe(1)
    })

    it('Meta+Shift+ArrowLeft calls onDedent (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowLeft', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDedent).toBe(1)
    })

    it('Tab does NOT call onIndent (Tab freed for focus navigation)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Tab')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onIndent).toBeUndefined()
      expect(cbs._calls.onDedent).toBeUndefined()
    })

    it('Ctrl+ArrowRight without Shift does NOT call onIndent', () => {
      const editor = makeEditor({ from: 5, to: 5 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowRight', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onIndent).toBeUndefined()
    })
  })

  describe('Backspace on empty', () => {
    it('Backspace on empty block calls onDeleteBlock with cursorPlacement end', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
    })

    it('Backspace on non-empty block at middle does nothing', () => {
      const editor = makeEditor({ isEmpty: false, from: 5, to: 5, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onDeleteBlock).toBeUndefined()
      expect(cbs._calls.onMergeWithPrev).toBeUndefined()
    })

    it('Backspace on empty does not flush (nothing to flush)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFlush).toBeUndefined()
    })

    it('Backspace on sole remaining block is a no-op (last-block guard)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks({ isLastBlock: () => true })
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBeUndefined()
      expect(cbs._deleteBlockArgs).toHaveLength(0)
    })

    it('Backspace on empty block when isLastBlock returns false proceeds with deletion', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks({ isLastBlock: () => false })
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
    })

    it('Backspace on empty block when isLastBlock is not provided proceeds with deletion', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onDeleteBlock).toBe(1)
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
      expect(cbs._calls.onEnterSave).toBe(1)
    })

    it('Shift+Enter does nothing (TipTap default handles line break)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onEnterSave).toBeUndefined()
    })
  })

  describe('Escape', () => {
    it('Escape calls onEscapeCancel', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Escape')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onEscapeCancel).toBe(1)
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

      expect(cbs._calls.onFocusPrev).toBe(1)
    })

    it('empty doc (docSize=2): cursor at 1 is both at start and end — ArrowDown → next', () => {
      // Empty paragraph: positions 0=before-p, 1=inside-p (cursor), 2=after-p
      // docSize = 2, atStart = 1 <= 1, atEnd = 1 >= 1. Both true!
      // ArrowUp checks first in code order, so ArrowDown should also work
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFocusNext).toBe(1)
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
      expect(cbs._calls.onMergeWithPrev).toBe(1)
      expect(cbs._calls.onDeleteBlock).toBeUndefined()
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
      expect(cbs._calls.onMergeWithPrev).toBe(1)
    })

    it('Backspace on empty block still calls onDeleteBlock with cursorPlacement end (no regression)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBe(1)
      expect(cbs._deleteBlockArgs[0]).toEqual({ cursorPlacement: 'end' })
      expect(cbs._calls.onMergeWithPrev).toBeUndefined()
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
      expect(cbs._calls.onMergeWithPrev).toBeUndefined()
      expect(cbs._calls.onDeleteBlock).toBeUndefined()
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
      expect(cbs._calls.onMergeWithPrev).toBeUndefined()
    })
  })

  describe('Ctrl+Enter (toggle todo)', () => {
    it('Ctrl+Enter calls onToggleTodo', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onToggleTodo).toBe(1)
      expect(cbs._calls.onEnterSave).toBeUndefined()
    })

    it('Meta+Enter calls onToggleTodo (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter', { metaKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onToggleTodo).toBe(1)
      expect(cbs._calls.onEnterSave).toBeUndefined()
    })

    it('plain Enter does NOT call onToggleTodo', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Enter')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onToggleTodo).toBeUndefined()
      expect(cbs._calls.onEnterSave).toBe(1)
    })
  })

  describe('Ctrl+. (toggle collapse)', () => {
    it('Ctrl+. calls onToggleCollapse', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onToggleCollapse).toBe(1)
    })

    it('Meta+. calls onToggleCollapse (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.', { metaKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onToggleCollapse).toBe(1)
    })

    it('plain . does NOT call onToggleCollapse', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('.')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(cbs._calls.onToggleCollapse).toBeUndefined()
    })
  })

  describe('Ctrl+Shift+Arrow (move block)', () => {
    it('Ctrl+Shift+ArrowUp calls onFlush + onMoveUp', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onMoveUp).toBe(1)
    })

    it('Ctrl+Shift+ArrowDown calls onFlush + onMoveDown', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown', { ctrlKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onMoveDown).toBe(1)
    })

    it('Meta+Shift+ArrowUp calls onMoveUp (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onMoveUp).toBe(1)
    })

    it('Meta+Shift+ArrowDown calls onMoveDown (macOS)', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown', { metaKey: true, shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onMoveDown).toBe(1)
    })

    it('Ctrl+ArrowUp without Shift does NOT call onMoveUp', () => {
      const editor = makeEditor({ from: 5, to: 5 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp', { ctrlKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onMoveUp).toBeUndefined()
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
      document.body.appendChild(popup)
      return popup
    }

    it('ArrowUp at start does NOT switch blocks when popup is visible', () => {
      addVisiblePopup()
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFocusPrev).toBeUndefined()
      expect(cbs._calls.onFlush).toBeUndefined()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('ArrowDown at end does NOT switch blocks when popup is visible', () => {
      addVisiblePopup()
      const editor = makeEditor({ from: 19, to: 19, selectionEmpty: true, docSize: 20 })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowDown')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFocusNext).toBeUndefined()
      expect(cbs._calls.onFlush).toBeUndefined()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('ArrowUp at start switches blocks when popup is absent', () => {
      // No popup added — should work normally
      const editor = makeEditor({ from: 1, to: 1, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('ArrowUp')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onFocusPrev).toBe(1)
      expect(cbs._calls.onFlush).toBe(1)
      expect(event.preventDefault).toHaveBeenCalled()
    })
  })
})
