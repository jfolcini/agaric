/**
 * Page mode's collapse (#5691): a collapsed block hides the deeper blocks that
 * follow it, from block mode's own saved layout, which a toggle writes; the
 * caret's block always shows; Enter keeps what a collapsed block hides with
 * it; and typing redraws nothing.
 */

import type { Editor } from '@tiptap/core'
import type { NodeType } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadCollapsedIds } from '@/components/block-tree/use-block-collapse'
import {
  blockId,
  caret,
  idMinter,
  openPage,
  PAGE,
  posIn,
  press,
  type Row,
  rowsOf,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { canMerge, mergeBlock } from '@/editor/page-mode/page-block-actions'
import { foldOf, pageCollapseKey, toggleFold } from '@/editor/page-mode/page-collapse'
import { PAGE_BLOCK, startOf } from '@/editor/page-mode/page-document'
import { indentIds } from '@/editor/page-mode/page-keys'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(blockId) as [
  string,
  string,
  string,
  string,
  string,
  string,
]
const NEW_1 = idMinter()()

let editor: Editor | null = null

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Row[], pageId?: string): Editor {
  editor = openPage(rows, idMinter(), undefined, undefined, undefined, pageId)
  return editor
}

/** The ids of the blocks shown hidden. */
function hidden(ed: Editor): string[] {
  return [...ed.view.dom.querySelectorAll('.page-block-hidden')].map(
    (el) => el.getAttribute('data-page-block-id') ?? '',
  )
}

function toggle(ed: Editor, id: string): boolean {
  return toggleFold(id)(ed.state, ed.view.dispatch)
}

/** The index of the block the caret is in. */
const caretBlock = (ed: Editor): number => ed.state.selection.$head.index(0)

const TREE: Row[] = [
  [A, 0, 'a'],
  [B, 1, 'b'],
  [C, 2, 'c'],
  [D, 1, 'd'],
  [E, 0, 'e'],
]

describe('collapse', () => {
  it('hides the deeper blocks after a collapsed block, up to the next as shallow, and shows them again', () => {
    const ed = build(TREE)
    caret(ed, 4, 0)

    expect(toggle(ed, B)).toBe(true)
    expect(hidden(ed)).toEqual([C])
    expect(toggle(ed, A)).toBe(true)
    expect(hidden(ed)).toEqual([B, C, D])
    expect(toggle(ed, A)).toBe(true)
    expect(hidden(ed)).toEqual([C])
    // A block with nothing under it has nothing to collapse.
    expect(toggle(ed, E)).toBe(false)
    // With no page, the layout stays in memory.
    expect(localStorage.length).toBe(0)
  })

  it('opens with block mode’s saved layout for the page, and saves a toggle there, pruned to the page’s blocks', () => {
    writePreference(PREFERENCES.blockCollapse, [B, 'GONE'], PAGE)
    const ed = build(TREE, PAGE)
    caret(ed, 4, 0)

    expect(hidden(ed)).toEqual([C])
    toggle(ed, A)
    expect(readPreference(PREFERENCES.blockCollapse, PAGE)).toEqual([B, A])
    toggle(ed, B)
    expect([...loadCollapsedIds(PAGE)]).toEqual([A])
    expect(hidden(ed)).toEqual([B, C, D])

    // Typing writes nothing there; only a toggle does.
    const write = vi.spyOn(window.localStorage, 'setItem')
    try {
      type(ed, 'x')
      expect(write).not.toHaveBeenCalled()
      toggle(ed, A)
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      write.mockRestore()
    }
  })

  it('shows the caret’s block: a collapsed block above it shows what it hides until the caret leaves, unsaved', () => {
    writePreference(PREFERENCES.blockCollapse, [A], PAGE)
    const ed = build(TREE, PAGE)
    caret(ed, 4, 0)
    expect(hidden(ed)).toEqual([B, C, D])

    caret(ed, 2, 1)

    expect(hidden(ed)).toEqual([])
    expect(readPreference(PREFERENCES.blockCollapse, PAGE)).toEqual([A])
    caret(ed, 3, 1)
    expect(hidden(ed)).toEqual([])
    caret(ed, 4, 0)
    expect(hidden(ed)).toEqual([B, C, D])
  })

  it('the reveal follows the caret from under one collapsed block to under another, and opens no other', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
      [D, 1, 'd'],
      [E, 0, 'e'],
      [F, 1, 'f'],
    ])
    caret(ed, 0, 1)
    for (const id of [A, C, E]) toggle(ed, id)
    expect(hidden(ed)).toEqual([B, D, F])
    // A caret before a block stays where it is.
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 1))

    caret(ed, 3, 1)
    expect(hidden(ed)).toEqual([B, F])
    caret(ed, 1, 1)
    expect(hidden(ed)).toEqual([D, F])
  })

  it('a selection of the whole page reveals nothing, and Ctrl+. on it collapses nothing', () => {
    const ed = build(TREE)
    caret(ed, 4, 0)
    toggle(ed, A)

    ed.commands.selectAll()

    expect(ed.state.selection.$head.depth).toBe(0)
    expect(hidden(ed)).toEqual([B, C, D])
    expect(press(ed, '.', { ctrlKey: true })).toBe(false)
    expect(hidden(ed)).toEqual([B, C, D])
  })

  it('the block menu collapses and expands a block while the whole page is selected', () => {
    const ed = build(TREE)
    ed.commands.selectAll()

    expect(toggle(ed, A)).toBe(true)
    expect(hidden(ed)).toEqual([B, C, D])
    expect(toggle(ed, A)).toBe(true)
    expect(hidden(ed)).toEqual([])
  })

  it('a block left first with its parent cut away is under no collapsed block', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
      [D, 1, 'd'],
    ])
    caret(ed, 0, 0)
    toggle(ed, C)
    caret(ed, 1, 1)

    ed.view.dispatch(ed.state.tr.delete(0, ed.state.doc.child(0).nodeSize))

    expect(rowsOf(ed.state.doc).map(([id, depth]) => [id, depth])).toEqual([
      [B, 0],
      [C, 0],
      [D, 1],
    ])
    expect(hidden(ed)).toEqual([D])
  })

  it('a block with nothing under it has no fold: no collapse, no Ctrl+., nothing for the menu', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
    caret(ed, 0, 1)

    expect(press(ed, '.', { ctrlKey: true })).toBe(false)
    expect(toggle(ed, A)).toBe(false)
    expect(toggle(ed, 'UNKNOWN')).toBe(false)
    expect(foldOf(ed.state, A)).toBeNull()
    expect(foldOf(ed.state, 'UNKNOWN')).toBeNull()
    expect(foldOf(ed.state, B)).toBe('expanded')
    toggle(ed, B)
    expect(foldOf(ed.state, B)).toBe('collapsed')
    expect(hidden(ed)).toEqual([C])
  })

  it('collapsing a block with the caret under it takes the caret to the block', () => {
    const ed = build(TREE)
    caret(ed, 2, 1)

    toggle(ed, A)

    expect(caretBlock(ed)).toBe(0)
    expect(hidden(ed)).toEqual([B, C, D])
  })

  it('Ctrl+. collapses and expands the caret’s block, and leaves the key alone on a block with nothing under it', () => {
    const ed = build(TREE)
    caret(ed, 0, 1)

    expect(press(ed, '.', { ctrlKey: true })).toBe(true)
    expect(hidden(ed)).toEqual([B, C, D])
    // The caret in the block itself stays where it is.
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 1))
    expect(press(ed, 'x')).toBe(false)
    expect(hidden(ed)).toEqual([B, C, D])
    expect(press(ed, '.', { ctrlKey: true })).toBe(true)
    expect(hidden(ed)).toEqual([])
    caret(ed, 4, 0)
    expect(press(ed, '.', { ctrlKey: true })).toBe(false)
  })

  it('a block moved under a collapsed block is hidden with what it hides', () => {
    const ed = build(TREE)
    caret(ed, 0, 0)
    toggle(ed, A)

    indentIds(() => [E])(ed.state, ed.view.dispatch)

    expect(rowsOf(ed.state.doc).map(([id, depth]) => [id, depth])).toEqual([
      [A, 0],
      [B, 1],
      [C, 2],
      [D, 1],
      [E, 1],
    ])
    expect(hidden(ed)).toEqual([B, C, D, E])
  })

  it('Tab on the caret’s block into a collapsed block shows it there, with what the block hides', () => {
    const ed = build(TREE)
    caret(ed, 0, 0)
    toggle(ed, A)
    caret(ed, 4, 1)

    expect(press(ed, 'Tab')).toBe(true)

    expect(rowsOf(ed.state.doc)[4]).toEqual([E, 1, 'e'])
    expect(caretBlock(ed)).toBe(4)
    expect(hidden(ed)).toEqual([])
  })

  it('typing in a block works out nothing again: what is hidden is mapped', () => {
    const ed = build(TREE)
    caret(ed, 0, 1)
    toggle(ed, A)
    const before = pageCollapseKey.getState(ed.state)?.hidden

    // Longer than a block after it, so what it hides moves past where it was.
    type(ed, ' and more')

    expect(pageCollapseKey.getState(ed.state)?.hidden).toBe(before)
    expect(hidden(ed)).toEqual([B, C, D])
    expect(rowsOf(ed.state.doc)[0]).toEqual([A, 0, 'a and more'])
  })
})

describe('Enter in a collapsed block', () => {
  const ROWS: Row[] = [
    [A, 0, 'ab'],
    [B, 1, 'b'],
    [C, 0, 'c'],
  ]

  it('at its end makes the new block after what it hides, which stays the block’s', () => {
    const ed = build(ROWS)
    caret(ed, 0, 2)
    toggle(ed, A)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [NEW_1, 0, ''],
      [C, 0, 'c'],
    ])
    expect(caretBlock(ed)).toBe(2)
    expect(hidden(ed)).toEqual([B])
  })

  it('at its end, with nothing after what it hides, makes the new block the page’s last', () => {
    const ed = build([
      [A, 0, 'ab'],
      [B, 1, 'b'],
    ])
    caret(ed, 0, 2)
    toggle(ed, A)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [NEW_1, 0, ''],
    ])
    expect(caretBlock(ed)).toBe(2)
  })

  it('in its text moves the text after the caret there too', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [NEW_1, 0, 'b'],
      [C, 0, 'c'],
    ])
    expect(caretBlock(ed)).toBe(2)
  })

  it('at its start makes the new block before it, and what it hides stays after its text', () => {
    const ed = build(ROWS)
    caret(ed, 0, 0)
    toggle(ed, A)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([
      [NEW_1, 0, ''],
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    expect(hidden(ed)).toEqual([B])
  })
})

describe('a paste of blocks into a collapsed block', () => {
  const ROWS: Row[] = [
    [A, 0, 'ab'],
    [B, 1, 'b'],
    [C, 0, 'c'],
  ]

  it('at its end puts the new blocks after what it hides, which stays the block’s', () => {
    const ed = build(ROWS)
    caret(ed, 0, 2)
    toggle(ed, A)

    ed.view.pasteHTML('<p>x</p><p>y</p>')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'abx'],
      [B, 1, 'b'],
      [NEW_1, 0, 'y'],
      [C, 0, 'c'],
    ])
    expect(hidden(ed)).toEqual([B])
    expect(ed.state.selection.from).toBe(posIn(ed, 2, 1))
  })

  it('in its text moves the text after the cursor there too, and a single paragraph splits nothing', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)

    ed.view.pasteHTML('<p>x</p><p>y</p>')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ax'],
      [B, 1, 'b'],
      [NEW_1, 0, 'yb'],
      [C, 0, 'c'],
    ])
    expect(ed.state.selection.from).toBe(posIn(ed, 2, 1))

    ed.commands.undo()
    expect(rowsOf(ed.state.doc)).toEqual(ROWS)
    expect(hidden(ed)).toEqual([B])

    caret(ed, 0, 1)
    ed.view.pasteHTML('<p>z</p>')
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'azb'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
  })
})

describe('a paste over the whole page', () => {
  it('replaces it as it would, though its first block is collapsed', () => {
    const ed = build([
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    caret(ed, 0, 1)
    toggle(ed, A)
    ed.commands.selectAll()

    ed.view.pasteHTML('<p>x</p><p>y</p>')

    expect(rowsOf(ed.state.doc).map(([, depth, text]) => [depth, text])).toEqual([
      [0, 'x'],
      [0, 'y'],
    ])
  })
})

describe('a block put between a collapsed block and what it hides', () => {
  const ROWS: Row[] = [
    [A, 0, 'ab'],
    [B, 1, 'b'],
    [C, 0, 'c'],
  ]
  const [X, Y] = [blockId(8), blockId(9)]

  /** Put blocks in at `index`, as `[id, depth, text]`. */
  function insert(ed: Editor, index: number, blocks: Array<[string, number, string]>): void {
    const { schema, doc } = ed.state
    const nodes = blocks.map(([id, depth, text]) =>
      (schema.nodes[PAGE_BLOCK] as NodeType).create(
        { blockId: id, depth },
        (schema.nodes['paragraph'] as NodeType).create(null, schema.text(text)),
      ),
    )
    ed.view.dispatch(ed.state.tr.insert(startOf(doc, index), nodes))
  }

  it('goes after what it hides, and the cursor stays where it was', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)

    insert(ed, 1, [[X, 0, 'x']])

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [X, 0, 'x'],
      [C, 0, 'c'],
    ])
    expect(hidden(ed)).toEqual([B])
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 1))
  })

  it('goes after what it hides, but a block under the collapsed block stays its', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)

    insert(ed, 1, [
      [Y, 1, 'y'],
      [X, 0, 'x'],
    ])

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ab'],
      [Y, 1, 'y'],
      [B, 1, 'b'],
      [X, 0, 'x'],
      [C, 0, 'c'],
    ])
    expect(hidden(ed)).toEqual([Y, B])
  })

  it('moves nothing when the change takes the collapsed block, or what it hides, away', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)

    ed.view.dispatch(ed.state.tr.delete(startOf(ed.state.doc, 0), startOf(ed.state.doc, 1)))
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([B, C])

    ed.commands.undo()
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, B, C])
    ed.view.dispatch(ed.state.tr.delete(startOf(ed.state.doc, 1), startOf(ed.state.doc, 2)))
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, C])
  })

  it('with nothing put between, Tab on a selection from a block below back into the collapsed block keeps that selection', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)
    toggle(ed, A)
    const { doc, tr } = ed.state
    ed.view.dispatch(tr.setSelection(TextSelection.create(doc, posIn(ed, 2, 1), posIn(ed, 0, 1))))

    expect(press(ed, 'Tab')).toBe(true)

    expect(rowsOf(ed.state.doc).map(([id, depth]) => [id, depth])).toEqual([
      [A, 0],
      [B, 1],
      [C, 1],
    ])
    expect([ed.state.selection.anchor, ed.state.selection.head]).toEqual([
      posIn(ed, 2, 1),
      posIn(ed, 0, 1),
    ])
  })

  it('is left where it is when the collapsed block is expanded, or the cursor is not in it', () => {
    const ed = build(ROWS)
    caret(ed, 0, 1)

    insert(ed, 1, [[X, 0, 'x']])

    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, X, B, C])

    ed.commands.undo()
    toggle(ed, A)
    caret(ed, 2, 0)
    insert(ed, 1, [[X, 0, 'x']])

    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, X, B, C])
  })
})

describe('Backspace and Delete next to a collapsed block', () => {
  const ROWS: Row[] = [
    [A, 0, 'ab'],
    [B, 1, 'b'],
    [C, 0, 'c'],
    [D, 1, 'd'],
  ]

  it('Backspace at the start of the block after what it hides joins the collapsed block, which keeps them', () => {
    const ed = build(ROWS)
    caret(ed, 0, 0)
    toggle(ed, A)
    caret(ed, 2, 0)

    expect(press(ed, 'Backspace')).toBe(true)

    // The block's own blocks go under the collapsed block, hidden with the rest.
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'abc'],
      [B, 1, 'b'],
      [D, 1, 'd'],
    ])
    expect(hidden(ed)).toEqual([B, D])
    expect(ed.state.selection.$head.index(0)).toBe(0)
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 2))
  })

  it('on an empty block it takes the block away and leaves the cursor at the end of the collapsed block, which stays collapsed', () => {
    const ed = build([
      [A, 0, 'ab'],
      [B, 1, 'b'],
      [C, 0, ''],
    ])
    caret(ed, 0, 0)
    toggle(ed, A)
    caret(ed, 2, 0)

    press(ed, 'Backspace')
    type(ed, 'x')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'abx'],
      [B, 1, 'b'],
    ])
    expect(hidden(ed)).toEqual([B])
  })

  it('Backspace after a block shown is the join it was, into that block', () => {
    const ed = build(ROWS)
    caret(ed, 0, 0)
    toggle(ed, A)
    toggle(ed, A)
    caret(ed, 2, 0)

    press(ed, 'Backspace')

    expect(rowsOf(ed.state.doc).slice(0, 2)).toEqual([
      [A, 0, 'ab'],
      [B, 1, 'bc'],
    ])
  })

  it('Delete at the end of a collapsed block joins the block after what it hides, not the first it hides', () => {
    const ed = build(ROWS)
    caret(ed, 0, 0)
    toggle(ed, A)
    caret(ed, 0, 2)

    expect(press(ed, 'Delete')).toBe(true)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'abc'],
      [B, 1, 'b'],
      [D, 1, 'd'],
    ])
    expect(hidden(ed)).toEqual([B, D])
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 2))
  })

  it('Delete at the end of a collapsed block with nothing shown after it does nothing', () => {
    const ed = build([
      [A, 0, 'ab'],
      [B, 1, 'b'],
    ])
    caret(ed, 0, 0)
    toggle(ed, A)
    caret(ed, 0, 2)

    expect(press(ed, 'Delete')).toBe(true)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'ab'],
      [B, 1, 'b'],
    ])
    expect(hidden(ed)).toEqual([B])
  })

  it('the block menu’s Merge on the block after what a collapsed block hides joins the collapsed block too', () => {
    const ed = build(ROWS)
    caret(ed, 0, 0)
    toggle(ed, A)

    expect(canMerge(ed.state, C)).toBe(true)
    expect(mergeBlock(C)(ed.state, ed.view.dispatch, ed.view)).toBe(true)

    expect(rowsOf(ed.state.doc)[0]).toEqual([A, 0, 'abc'])
    expect(hidden(ed)).toEqual([B, D])
  })
})
