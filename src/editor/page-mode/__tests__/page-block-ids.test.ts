/**
 * Page mode's id rules (#5691): a real TipTap editor over page mode's
 * extensions; keys go through ProseMirror's `handleKeyDown` and the clipboard
 * through the view's own copy and paste. A peer's change is the transaction a
 * remote patch dispatches.
 *
 * Equivalent mutants, accepted:
 * - `changesBlocks` made true more often (a step's `attr` or `pos` check, its
 *   `from` or `to` check, the `nodeAt` test, its `?.`, the same-block test,
 *   `false` → `true`, and `structural` or `!remote` in `appendTransaction`
 *   widened or dropped): each only runs the id rules over a change that moves
 *   no id, which appends nothing. A step with a `pos` and no `attr`, or the
 *   reverse, is not one an editor makes. `from` and `to` come with any `slice`.
 * - `rule === null` in `restoredIds`, `id !== null` where `known` is filled,
 *   and `rules !== null` before `restoredIds`: a `null` is never a held id, and
 *   a peer's patch is never in one pass with a history step.
 * - `$from.index(1) === 0` and `$from.parentOffset === 0` in `handlePaste`: a
 *   block whose start did not move keeps its id by the rules, whatever the
 *   paste set it to.
 * - `!holdsPageBlock` in `handlePaste` made false: the default paste sets the
 *   same marks on the same transaction.
 * - The extension's name and the plugin key's: nothing looks either up.
 */

import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, type NodeType, Slice } from '@tiptap/pm/model'
import type { EditorState, Plugin, Transaction } from '@tiptap/pm/state'
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
import { PageBlockIds, pageBlockIdsKey } from '@/editor/page-mode/page-block-ids'
import { REMOTE_PATCH, startOf } from '@/editor/page-mode/page-document'
import { newBlockId } from '@/lib/block-id'

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

/** A peer's change as `remotePatch` brings it in: outside undo history, marked remote. */
function fromPeer(ed: Editor, change: (tr: Transaction) => Transaction): void {
  ed.view.dispatch(change(ed.state.tr).setMeta('addToHistory', false).setMeta(REMOTE_PATCH, true))
}

/** A peer's edit of block `index`, which holds one paragraph: `text` in place of its text. */
function peerRewrites(ed: Editor, index: number, text: string): void {
  const from = posIn(ed, index, 0)
  const to = posIn(ed, index, ed.state.doc.child(index).textContent.length)
  fromPeer(ed, (tr) =>
    text === '' ? tr.delete(from, to) : tr.replaceWith(from, to, ed.state.schema.text(text)),
  )
}

/** A block of one paragraph, new to the page or brought back, inserted at `index` under `id`. */
function peerAdds(ed: Editor, index: number, id: string, text: string): void {
  const block = ed.state.schema.nodeFromJSON({
    type: 'pageBlock',
    attrs: { blockId: id, depth: 0 },
    content: [{ type: 'paragraph', content: text === '' ? [] : [{ type: 'text', text }] }],
  })
  fromPeer(ed, (tr) => tr.insert(startOf(ed.state.doc, index), block))
}

describe('undo and redo after a peer’s change', () => {
  it('put a cut text back under its id, though a peer rewrote the block it was pasted into', () => {
    const ed = build([
      [A, 0, 'alpha'],
      [B, 0, 'alpha'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 1, 5))
    ed.view.dispatch(closeHistory(ed.state.tr))
    caret(ed, 0, 0)
    ed.view.pasteHTML(html)
    peerRewrites(ed, 0, 'peer ')
    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'peer '],
      [NEW_1, 0, ''],
    ])

    // The rules follow the first character, the peer's, which held B's id; the undo put A back.
    ed.commands.undo()
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'peer '],
      [NEW_1, 0, ''],
    ])
    ed.commands.undo()
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'peer '],
      [B, 0, 'alpha'],
    ])

    ed.commands.redo()
    ed.commands.redo()
    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'peer '],
      [NEW_1, 0, ''],
    ])
  })

  it('give the block an undo re-creates a new id when a peer has brought the original back', () => {
    const ed = build([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    peerAdds(ed, 1, B, 'bar')
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'foobar'],
      [B, 0, 'bar'],
    ])

    // The block this undo re-creates and the peer's both hold B.
    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, 'bar'],
      [B, 0, 'bar'],
    ])
  })

  it('keep a joined block’s id when a peer emptied it, though the rules would move it on', () => {
    const ed = build([
      [A, 0, 'alpha'],
      [B, 0, ''],
    ])
    caret(ed, 0, 5)
    press(ed, 'Delete')
    peerRewrites(ed, 0, '')
    peerAdds(ed, 1, B, 'peer')

    // A is empty, so the rules follow its end, which the undo's split puts in the second half.
    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, ''],
      [NEW_1, 0, ''],
      [B, 0, 'peer'],
    ])
  })

  it('leave every block its id when a peer’s rewrite left nothing of the undone steps', () => {
    const ed = build([[A, 0, 'alpha']])
    caret(ed, 0, 2)
    ed.view.pasteText('x\ny')
    expect(idsOf(ed.state.doc)).toEqual([A, NEW_1])
    peerRewrites(ed, 0, 'peer')
    peerRewrites(ed, 1, 'peer2')

    // Both halves are the peer's now: the undo finds no paste to take out, and unsets an id.
    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'peer'],
      [NEW_1, 0, 'peer2'],
    ])
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

describe('what a paste brings in', () => {
  function transformed(ed: Editor, slice: Slice): Slice {
    return ed.view.someProp('transformPasted', (f) => f(slice, ed.view, false)) as Slice
  }

  function pageBlocks(ed: Editor, depths: number[]): Slice {
    const pageBlock = ed.schema.nodes['pageBlock'] as NodeType
    const paragraph = ed.schema.nodes['paragraph'] as NodeType
    const nodes = depths.map((depth) =>
      pageBlock.create({ blockId: null, depth }, paragraph.create(null, ed.schema.text('x'))),
    )
    return new Slice(Fragment.from(nodes), 0, 0)
  }

  it('over select all, several blocks with no id stay as they are', () => {
    const ed = build([[A, 0, 'one']])
    ed.commands.selectAll()

    const slice = transformed(ed, pageBlocks(ed, [0, 0]))

    expect(slice.content.childCount).toBe(2)
  })

  it('inside a block, one block with no id keeps its depth and its closed edges', () => {
    const ed = build([[A, 0, 'one']])
    caret(ed, 0, 1)

    const slice = transformed(ed, pageBlocks(ed, [1]))

    expect([slice.openStart, slice.content.child(0).attrs['depth']]).toEqual([0, 1])
  })

  it('over select all, a slice of no blocks stays as it is', () => {
    const ed = build([[A, 0, 'one']])
    ed.commands.selectAll()
    const slice = new Slice(
      Fragment.from((ed.schema.nodes['paragraph'] as NodeType).create()),
      0,
      0,
    )

    expect(transformed(ed, slice)).toBe(slice)
  })

  it('a paste of blocks from this page is marked as a paste', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    const html = cut(ed, posIn(ed, 1, 0), posIn(ed, 1, 3))
    caret(ed, 0, 0)
    const metas: unknown[] = []
    ed.on('transaction', ({ transaction }) =>
      metas.push([transaction.getMeta('paste'), transaction.getMeta('uiEvent')]),
    )

    ed.view.pasteHTML(html)

    expect(metas[0]).toEqual([true, 'paste'])
  })
})

describe('the plugin over several transactions', () => {
  function bare(ed: Editor): { state: EditorState; append: PluginAppend } {
    const plugin = ed.state.plugins.find((p) => p.spec.key === pageBlockIdsKey) as Plugin
    return {
      state: ed.state.reconfigure({ plugins: [] }),
      append: (trs, oldState, newState) => plugin.spec.appendTransaction?.(trs, oldState, newState),
    }
  }
  type PluginAppend = (
    trs: Transaction[],
    oldState: EditorState,
    newState: EditorState,
  ) => Transaction | null | undefined

  it('one that splits a block counts, though a later one only types', () => {
    const ed = build([[A, 0, 'foo bar']])
    const { state, append } = bare(ed)
    const split = state.tr.split(posIn(ed, 0, 3), 2)
    const s1 = state.apply(split)
    const typed = s1.tr.insertText('z', posIn(ed, 0, 1))
    const s2 = s1.apply(typed)

    const fixed = append([split, typed], state, s2)

    expect(fixed?.doc.child(1).attrs['blockId']).toBe(NEW_1)
  })

  it('one that is a peer’s patch keeps the backend’s ids, though a later one is not', () => {
    const ed = build([[A, 0, 'one']])
    const { state, append } = bare(ed)
    const patch = state.tr.setNodeAttribute(0, 'blockId', B).setMeta(REMOTE_PATCH, true)
    const s1 = state.apply(patch)
    const typed = s1.tr.insertText('z', posIn(ed, 0, 1))
    const s2 = s1.apply(typed)

    expect(append([patch, typed], state, s2)).toBeNull()
  })

  it('one that is an undo puts back its ids, though a later one is not', () => {
    const ed = build([[A, 0, 'one']])
    const { state, append } = bare(ed)
    const undone = state.tr.setNodeAttribute(0, 'blockId', B).setMeta('history$', { redo: false })
    const s1 = state.apply(undone)
    const typed = s1.tr.insertText('z', posIn(ed, 0, 1))
    const s2 = s1.apply(typed)

    expect(append([undone, typed], state, s2)).toBeNull()
  })

  it('a change that leaves every id and depth as they are appends nothing', () => {
    const ed = build([[A, 0, 'one']])

    const { transactions } = ed.state.applyTransaction(ed.state.tr.setNodeAttribute(0, 'depth', 0))

    expect(transactions).toHaveLength(1)
  })
})

it('mints ids with newBlockId unless told otherwise', () => {
  expect(PageBlockIds.options.mintId).toBe(newBlockId)
})
