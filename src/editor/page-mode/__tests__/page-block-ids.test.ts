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
        `<div data-page-block="" data-page-block-id="${blockId(98)}" data-depth="1"><p>y</p></div>`,
    )

    expect(idsOf(ed.state.doc)).toEqual([A, NEW_1])
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'onex'],
      [NEW_1, 1, 'y'],
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

const D = blockId(4)

/** Cut the selection `from`–`to` through the view, as Ctrl+X does; resolves the clipboard's HTML. */
function cut(ed: Editor, from: number, to: number): string {
  ed.commands.setTextSelection({ from, to })
  const data = new DataTransfer()
  ed.view.dom.dispatchEvent(
    new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
  )
  return data.getData('text/html')
}

describe('cut and paste', () => {
  it('a cut of whole blocks, pasted where a block starts, moves them under their ids', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
      [D, 0, 'four'],
    ])
    const html = cut(ed, posIn(ed, 0, 0), posIn(ed, 2, 0))
    expect(rowsOf(ed.state.doc)).toEqual([
      [C, 0, 'three'],
      [D, 0, 'four'],
    ])
    caret(ed, 1, 0)

    ed.view.pasteHTML(html)

    expect(rowsOf(ed.state.doc)).toEqual([
      [C, 0, 'three'],
      [A, 0, 'one'],
      [B, 0, 'two'],
      [D, 0, 'four'],
    ])
  })

  it('a cut that leaves a block’s start leaves it its id, and the rest moves', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    const html = cut(ed, posIn(ed, 0, 1), posIn(ed, 1, 3))
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'o'],
      [C, 0, 'three'],
    ])
    caret(ed, 1, 5)

    ed.view.pasteHTML(html)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'o'],
      [C, 0, 'threene'],
      [B, 0, 'two'],
    ])
  })

  it('a cut of a block’s start leaves the id on the rest of the block', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])

    cut(ed, posIn(ed, 0, 0), posIn(ed, 0, 2))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'e'],
      [B, 0, 'two'],
    ])
  })

  it('an empty block cut first, pasted where a block starts, hands no id on: the text keeps its own', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, ''],
      [C, 0, 'three'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 2, 5))
    caret(ed, 0, 0)

    ed.view.pasteHTML(html)

    const rows = rowsOf(ed.state.doc)
    expect(rows.find(([, , text]) => text.startsWith('three'))?.[0]).toBe(C)
    expect(rows.map(([id]) => id)).not.toContain(B)
  })

  it('pasting the same cut again brings copies, under new ids', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 2, 0))
    caret(ed, 1, 0)
    ed.view.pasteHTML(html)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    caret(ed, 2, 0)

    ed.view.pasteHTML(html)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [NEW_1, 0, 'two'],
      [C, 0, 'three'],
    ])
  })

  it('a block whose whole text a cut takes is left with a new id, not its own', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])

    cut(ed, posIn(ed, 0, 0), posIn(ed, 0, 3))

    expect(rowsOf(ed.state.doc)).toEqual([
      [NEW_1, 0, ''],
      [B, 0, 'two'],
    ])
  })

  it('a copy pasted where a block starts leaves the original its id', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 0), to: posIn(ed, 1, 0) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    caret(ed, 1, 0)

    ed.view.pasteHTML(data.getData('text/html'))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [NEW_1, 0, 'one'],
      [B, 0, 'two'],
    ])
  })

  it('a copy of a block’s text pasted into an empty block leaves that block its id', () => {
    const ed = build([
      [A, 0, ''],
      [B, 0, 'two'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 1, 3) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    caret(ed, 0, 0)

    ed.view.pasteHTML(data.getData('text/html'))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'two'],
      [B, 0, 'two'],
    ])
  })

  it('one block’s text, cut and pasted where a block starts, starts that block under its id', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 1, 3))
    caret(ed, 0, 0)

    ed.view.pasteHTML(html)

    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'twoone'],
      [NEW_1, 0, ''],
    ])
  })

  it('whole blocks pasted, joining none, keep their ids, and the block pasted into its own', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    cut(ed, posIn(ed, 1, 0), posIn(ed, 2, 5))
    caret(ed, 0, 0)
    const block = (id: string, text: string) =>
      `<div data-page-block="" data-page-block-id="${id}" data-depth="0"><p>${text}</p></div>`

    ed.view.pasteHTML(
      block(B, 'two').replace('<div ', '<div data-pm-slice="0 0 []" ') + block(C, 'three'),
    )

    const rows = rowsOf(ed.state.doc)
    expect(rows).toContainEqual([A, 0, 'one'])
    expect(rows).toContainEqual([B, 0, 'two'])
    expect(rows).toContainEqual([C, 0, 'three'])
  })

  it('blocks dragged within the page keep their ids, and the place they left takes a new one', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 0), to: posIn(ed, 0, 3) })
    const slice = ed.state.selection.content()
    const tr = ed.state.tr.deleteSelection()
    const end = tr.doc.content.size
    tr.replaceRange(end, end, slice)

    ed.view.dispatch(tr.setMeta('uiEvent', 'drop'))

    expect(rowsOf(ed.state.doc)).toEqual([
      [NEW_1, 0, ''],
      [B, 0, 'two'],
      [C, 0, 'three'],
      [A, 0, 'one'],
    ])
  })
})

/** The position just after the first occurrence of `text` in the document. */
function after(ed: Editor, text: string): number {
  let found = -1
  ed.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? '').indexOf(text) : -1
    if (found === -1 && at !== -1) found = pos + at + text.length
    return found === -1
  })
  return found
}

describe('paste from outside the page', () => {
  it('paragraphs become blocks at the depth of the block pasted into, splitting it', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 1, 'two'],
    ])
    caret(ed, 1, 1)

    ed.view.pasteHTML('<p>x</p><p>y</p><p>z</p>')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 1, 'tx'],
      [NEW_1, 1, 'y'],
      [NEW_2, 1, 'zwo'],
    ])
  })

  it('lines of plain text become blocks', () => {
    const ed = build([[A, 0, 'one']])
    caret(ed, 0, 3)

    ed.view.pasteText('x\ny')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'onex'],
      [NEW_1, 0, 'y'],
    ])
  })

  it('a single paragraph goes into the block at the cursor', () => {
    const ed = build([[A, 0, 'one']])
    caret(ed, 0, 3)

    ed.view.pasteHTML('<p>x</p>')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'onex']])
  })

  it('paragraphs pasted inside a list in a block stay in that block', () => {
    const ed = build([[A, 0, '- item']])
    ed.commands.setTextSelection(after(ed, 'item'))

    ed.view.pasteHTML('<p>x</p><p>y</p>')

    expect(idsOf(ed.state.doc)).toEqual([A])
    expect(ed.state.doc.child(0).textContent).toBe('itemxy')
  })
})

describe('one transaction, several steps', () => {
  it('Enter over a selection inside a block gives the new block an id of its own', () => {
    const ed = build([[A, 0, 'one two']])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 3), to: posIn(ed, 0, 4) })

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one'],
      [NEW_1, 0, 'two'],
    ])
  })

  it('a mark set inside a block changes no id', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 1, 2) })

    ed.commands.toggleMark('bold')

    expect(idsOf(ed.state.doc)).toEqual([A, B])
    expect(rowsOf(ed.state.doc)[1]).toEqual([B, 0, '**tw**o'])
  })
})

describe('a cut block pasted where no block starts', () => {
  it('pasted at the start of a list item inside a block, leaves that block its id', () => {
    const ed = build([
      [A, 0, '- item'],
      [B, 0, 'two'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 1, 3))
    ed.commands.setTextSelection(after(ed, 'item') - 'item'.length)

    ed.view.pasteHTML(html)

    expect(idsOf(ed.state.doc)[0]).toBe(A)
    expect(ed.state.doc.child(0).textContent).toBe('twoitem')
  })
})

it('a block made while the page is open, cut and pasted where a block starts, keeps its id', () => {
  const ed = build([
    [A, 0, 'one'],
    [B, 0, 'two'],
  ])
  caret(ed, 0, 3)
  press(ed, 'Enter')
  type(ed, 'new')
  expect(idsOf(ed.state.doc)).toEqual([A, NEW_1, B])
  const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 2, 0))
  caret(ed, 0, 0)

  ed.view.pasteHTML(html)

  expect(rowsOf(ed.state.doc)).toEqual([
    [NEW_1, 0, 'new'],
    [A, 0, 'one'],
    [B, 0, 'two'],
  ])
})

it('select all, then paragraphs pasted from outside, become blocks of their own', () => {
  const ed = build([
    [A, 0, 'one'],
    [B, 1, 'two'],
  ])
  ed.commands.selectAll()

  ed.view.pasteHTML('<p>x</p><p>y</p>')

  expect(rowsOf(ed.state.doc).map(([, depth, text]) => [depth, text])).toEqual([
    [0, 'x'],
    [0, 'y'],
  ])
})

it('select all, then blocks cut from this page pasted, brings them back under their ids', () => {
  const ed = build([
    [A, 0, 'one'],
    [B, 1, 'two'],
    [C, 0, 'three'],
  ])
  const html = cut(ed, posIn(ed, 0, 0), posIn(ed, 2, 0))
  ed.commands.selectAll()

  ed.view.pasteHTML(html)

  // After them, an empty block: the cut ended where C starts.
  expect(rowsOf(ed.state.doc).slice(0, 2)).toEqual([
    [A, 0, 'one'],
    [B, 1, 'two'],
  ])
})

it('a block left first moves to the top level', () => {
  const ed = build([
    [A, 0, 'one'],
    [B, 1, 'two'],
  ])

  ed.view.dispatch(ed.state.tr.delete(0, ed.state.doc.child(0).nodeSize))

  expect(rowsOf(ed.state.doc)).toEqual([[B, 0, 'two']])
})

it('select all, then one block’s text cut from this page pasted, brings it back under its id', () => {
  const ed = build([
    [A, 0, 'one'],
    [B, 0, 'two'],
  ])
  const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 1, 3))
  ed.commands.selectAll()

  ed.view.pasteHTML(html)

  expect(rowsOf(ed.state.doc)).toEqual([[B, 0, 'two']])
})
