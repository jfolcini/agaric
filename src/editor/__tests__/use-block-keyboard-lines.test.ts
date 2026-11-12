/**
 * #6537 — Arrow Up / Down leave a block from its first / last visual line with
 * the caret's x, and Shift+Arrow at the block's edge hands over to block
 * selection. The documents are real ProseMirror docs; the view's line geometry,
 * which jsdom does not lay out, is a stub (`e2e/editor-keyboard-6537.spec.ts`
 * drives the real one).
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Selection, TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { setSelectionProbe } from '@/editor/pm-selection-probe'
import {
  type BlockKeyboardCallbacks,
  type EditorLike,
  handleBlockKeyDown,
} from '@/editor/use-block-keyboard'

beforeAll(() => {
  setSelectionProbe({
    atStartFrom: (doc) => Selection.atStart(doc as never).from,
    atEndTo: (doc) => Selection.atEnd(doc as never).to,
  })
})

let editor: Editor | undefined
afterEach(() => {
  editor?.destroy()
  editor = undefined
})

const FIRST = 'first paragraph'
const SECOND = 'second paragraph'

/** Two paragraphs, the selection `anchor`→`head`, and a view whose caret is at x 42. */
function twoParagraphs(anchor: number, head: number, lineEdge: boolean): EditorLike {
  editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        { type: 'paragraph', content: [{ type: 'text', text: SECOND }] },
      ],
    },
  })
  const { state } = editor
  const withSelection = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, anchor, head)),
  )
  return {
    state: withSelection,
    isEmpty: false,
    view: { endOfTextblock: () => lineEdge, coordsAtPos: () => ({ left: 42 }) },
  }
}

// Positions: the first paragraph's text runs 1..16, the second's 18..34.
const IN_FIRST = 5
const IN_SECOND = 22
const DOC_END = 18 + SECOND.length

function callbacks() {
  return {
    onFocusPrev: vi.fn(),
    onFocusNext: vi.fn(),
    onSelectWithNeighbour: vi.fn(),
    onDeleteBlock: vi.fn(),
    onIndent: vi.fn(),
    onDedent: vi.fn(),
    onFlush: vi.fn(() => null),
    onMergeWithPrev: vi.fn(),
    onEnterSave: vi.fn(),
    onEscapeSave: vi.fn(),
  } satisfies BlockKeyboardCallbacks
}

function press(key: string, shiftKey = false) {
  return { key, shiftKey, ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn() }
}

describe('Arrow Up / Down between blocks (#6537)', () => {
  it('ArrowUp on the first line of the first paragraph leaves with the caret x', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowUp'), twoParagraphs(IN_FIRST, IN_FIRST, true), cb)
    expect(cb.onFlush).toHaveBeenCalledOnce()
    expect(cb.onFocusPrev).toHaveBeenCalledWith(42)
  })

  it('ArrowUp on the first line of a later paragraph stays in the block', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowUp'), twoParagraphs(IN_SECOND, IN_SECOND, true), cb)
    expect(cb.onFocusPrev).not.toHaveBeenCalled()
  })

  it('ArrowUp below the first visual line stays in the block', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowUp'), twoParagraphs(IN_FIRST, IN_FIRST, false), cb)
    expect(cb.onFocusPrev).not.toHaveBeenCalled()
  })

  it('ArrowDown on the last line of the last paragraph leaves with the caret x', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowDown'), twoParagraphs(IN_SECOND, IN_SECOND, true), cb)
    expect(cb.onFocusNext).toHaveBeenCalledWith(42)
  })

  it('ArrowDown on the last line of an earlier paragraph stays in the block', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowDown'), twoParagraphs(IN_FIRST, IN_FIRST, true), cb)
    expect(cb.onFocusNext).not.toHaveBeenCalled()
  })

  it('ArrowLeft at the start leaves without an x, so the caret lands at the default place', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowLeft'), twoParagraphs(1, 1, true), cb)
    expect(cb.onFocusPrev).toHaveBeenCalledWith()
  })
})

describe('Shift+Arrow at the block edge (#6537)', () => {
  it('Shift+ArrowDown with the selection already at the end selects the block and the next', () => {
    const cb = callbacks()
    const event = press('ArrowDown', true)
    handleBlockKeyDown(event, twoParagraphs(IN_FIRST, DOC_END, true), cb)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(cb.onFlush).toHaveBeenCalledOnce()
    expect(cb.onSelectWithNeighbour).toHaveBeenCalledWith('down')
  })

  it('Shift+ArrowUp with the selection already at the start selects the block and the previous', () => {
    const cb = callbacks()
    handleBlockKeyDown(press('ArrowUp', true), twoParagraphs(IN_SECOND, 1, true), cb)
    expect(cb.onSelectWithNeighbour).toHaveBeenCalledWith('up')
  })

  it('Shift+ArrowDown before the end extends the text selection, as before (#910)', () => {
    const cb = callbacks()
    const event = press('ArrowDown', true)
    handleBlockKeyDown(event, twoParagraphs(IN_FIRST, IN_SECOND, true), cb)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(cb.onSelectWithNeighbour).not.toHaveBeenCalled()
    expect(cb.onFocusNext).not.toHaveBeenCalled()
  })
})
