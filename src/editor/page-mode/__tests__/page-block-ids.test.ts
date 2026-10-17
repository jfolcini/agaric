/**
 * Page mode's id rules (#5691): a real TipTap editor over page mode's
 * extensions; keys go through ProseMirror's `handleKeyDown` and the clipboard
 * through the view's own copy and paste.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  idsOf,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const NEW_1 = '01NEW000000000000000000001'
const NEW_2 = '01NEW000000000000000000002'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Row[]): Editor {
  editor = openPage(rows)
  return editor
}

describe('Enter', () => {
  it('in the middle of a block keeps the id on the first half and mints one for the rest', () => {
    const ed = build([
      [A, 0, 'foo bar'],
      [B, 0, 'next'],
    ])
    caret(ed, 0, 3)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, ' bar'],
      [B, 0, 'next'],
    ])
  })

  it('at the start of a block moves the id down with the text, leaving a new empty block above', () => {
    const ed = build([[A, 0, 'foo']])
    caret(ed, 0, 0)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [NEW_1, 0, ''],
      [A, 0, 'foo'],
    ])
  })

  it('keeps the depth of the block it splits', () => {
    const ed = build([
      [A, 0, 'parent'],
      [B, 1, 'child text'],
    ])
    caret(ed, 1, 5)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'parent'],
      [B, 1, 'child'],
      [NEW_1, 1, ' text'],
    ])
  })
})

describe('joins', () => {
  it('Backspace at the start of a block keeps the first id and drops the second', () => {
    const ed = build([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
      [C, 0, 'baz'],
    ])
    caret(ed, 1, 0)

    press(ed, 'Backspace')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'foobar'],
      [C, 0, 'baz'],
    ])
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 3))
  })

  it('Delete at the end of a block keeps its id and drops the next one', () => {
    const ed = build([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 0, 3)

    press(ed, 'Delete')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'foobar']])
  })

  it('a selection across blocks, deleted, keeps the first block and its id', () => {
    const ed = build([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
      [C, 0, 'baz'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 1), to: posIn(ed, 2, 1) })

    press(ed, 'Backspace')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'faz']])
  })

  it('leaves the joined block’s children at most one level under the block before them', () => {
    const ed = build([
      [A, 0, 'top'],
      [B, 1, 'middle'],
      [C, 2, 'deep'],
    ])
    caret(ed, 1, 0)

    press(ed, 'Backspace')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'topmiddle'],
      [C, 1, 'deep'],
    ])
  })
})

describe('paste and duplicates', () => {
  it('a paste of blocks copied from the page brings them in under new ids', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 0), to: posIn(ed, 1, 3) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    caret(ed, 2, 5)

    ed.view.pasteHTML(data.getData('text/html'))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'threeone'],
      [NEW_1, 0, 'two'],
    ])
  })

  it('a paste brings in no ids, not even another page’s, which this page cannot create', () => {
    const ed = build([[A, 0, 'one']])
    const other = blockId(99)
    caret(ed, 0, 3)

    ed.view.pasteHTML(
      `<div data-page-block="" data-page-block-id="${other}" data-depth="0"><p>x</p></div>` +
        `<div data-page-block="" data-page-block-id="${blockId(98)}" data-depth="0"><p>y</p></div>`,
    )

    expect(idsOf(ed.state.doc)).toEqual([A, NEW_1])
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'onex'],
      [NEW_1, 0, 'y'],
    ])
  })

  it('a block brought in under an id the page holds gets a new one, and the first keeps it', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])

    ed.commands.insertContentAt(ed.state.doc.content.size, {
      type: 'pageBlock',
      attrs: { blockId: A, depth: 0 },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'copy' }] }],
    })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [NEW_1, 0, 'copy'],
    ])
  })

  it('a block brought in without an id gets one at once', () => {
    const ed = build([[A, 0, 'one']])

    ed.commands.insertContentAt(ed.state.doc.content.size, {
      type: 'pageBlock',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
    })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [NEW_1, 0, 'two'],
    ])
  })

  it('an id set on a block whose text another block’s id starts goes back to that id', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])

    ed.view.dispatch(ed.state.tr.setNodeAttribute(ed.state.doc.child(0).nodeSize, 'blockId', A))

    expect(idsOf(ed.state.doc)).toEqual([A, B])
  })
})

describe('undo', () => {
  it('undoing a split brings back the block whole under its id', () => {
    const ed = build([[A, 0, 'foo bar']])
    caret(ed, 0, 3)
    press(ed, 'Enter')
    expect(idsOf(ed.state.doc)).toEqual([A, NEW_1])

    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'foo bar']])
  })

  it('undoing a join brings the dropped block back under its own id', () => {
    const ed = build([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')

    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
  })

  it('redoing a split gives the new block the id it had, not another', () => {
    const ed = build([[A, 0, 'foo bar']])
    caret(ed, 0, 3)
    press(ed, 'Enter')
    ed.commands.undo()

    ed.commands.redo()

    expect(idsOf(ed.state.doc)).toEqual([A, NEW_1])
    expect(idsOf(ed.state.doc)).not.toContain(NEW_2)
  })
})

it('typing inside a block leaves every id where it was', () => {
  const ed = build([
    [A, 0, 'foo'],
    [B, 1, 'bar'],
  ])
  caret(ed, 1, 0)

  type(ed, 'x')

  expect(rowsOf(ed.state.doc)).toEqual([
    [A, 0, 'foo'],
    [B, 1, 'xbar'],
  ])
})
