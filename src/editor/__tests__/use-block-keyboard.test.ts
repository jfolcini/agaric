import { describe, expect, it, vi } from 'vitest'
import {
  type BlockKeyboardCallbacks,
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

function makeCallbacks(): BlockKeyboardCallbacks & { _calls: Record<string, number> } {
  const _calls: Record<string, number> = {}
  const track = (name: string) => () => {
    _calls[name] = (_calls[name] ?? 0) + 1
  }
  return {
    onFocusPrev: track('onFocusPrev'),
    onFocusNext: track('onFocusNext'),
    onDeleteBlock: track('onDeleteBlock'),
    onIndent: track('onIndent'),
    onDedent: track('onDedent'),
    onFlush: () => {
      _calls.onFlush = (_calls.onFlush ?? 0) + 1
      return null
    },
    onMergeWithPrev: track('onMergeWithPrev'),
    onEnterSave: track('onEnterSave'),
    onEscapeCancel: track('onEscapeCancel'),
    _calls,
  }
}

function makeEvent(
  key: string,
  opts: Partial<{ shiftKey: boolean }> = {},
): Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'> {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
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

  describe('Tab / Shift+Tab', () => {
    it('Tab calls onFlush + onIndent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Tab')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onIndent).toBe(1)
      expect(cbs._calls.onDedent).toBeUndefined()
    })

    it('Shift+Tab calls onFlush + onDedent', () => {
      const editor = makeEditor({})
      const cbs = makeCallbacks()
      const event = makeEvent('Tab', { shiftKey: true })

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onFlush).toBe(1)
      expect(cbs._calls.onDedent).toBe(1)
      expect(cbs._calls.onIndent).toBeUndefined()
    })

    it('Tab at position 0 still indents (Tab takes priority)', () => {
      const editor = makeEditor({ from: 0, to: 0, selectionEmpty: true })
      const cbs = makeCallbacks()
      const event = makeEvent('Tab')

      handleBlockKeyDown(event, editor, cbs)

      expect(cbs._calls.onIndent).toBe(1)
      expect(cbs._calls.onFocusPrev).toBeUndefined()
    })
  })

  describe('Backspace on empty', () => {
    it('Backspace on empty block calls onDeleteBlock', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBe(1)
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

    it('Backspace on empty block still calls onDeleteBlock (no regression)', () => {
      const editor = makeEditor({ isEmpty: true, from: 1, to: 1, docSize: 2 })
      const cbs = makeCallbacks()
      const event = makeEvent('Backspace')

      handleBlockKeyDown(event, editor, cbs)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(cbs._calls.onDeleteBlock).toBe(1)
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
})
