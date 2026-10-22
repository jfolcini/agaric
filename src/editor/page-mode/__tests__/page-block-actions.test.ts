/**
 * The block menu's structural rows as document commands (#5972): each acts on
 * the blocks it names, wherever the cursor is, and leaves the cursor where it was.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  idMinter,
  openPage,
  press,
  type Row,
  rowsOf,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockIdsBetween,
  canMerge,
  deleteBlocks,
  duplicateBlock,
  mergeBlock,
  moveBlocks,
} from '@/editor/page-mode/page-block-actions'
import { indentIds, outdentIds } from '@/editor/page-mode/page-keys'

const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(blockId) as [string, string, string, string, string]

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Row[]): Editor {
  editor = openPage(rows, idMinter())
  return editor
}

describe('moveBlocks', () => {
  it('swaps a block, with the blocks under it, with the sibling before it', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 0, 'd'],
    ])

    expect(moveBlocks([D], -1)(ed.state, ed.view.dispatch)).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [D, 0, 'd'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])

    moveBlocks([A], 1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([D, A, B, C])
    moveBlocks([A], 1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc)).toEqual([
      [D, 0, 'd'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [A, 0, 'a'],
    ])
  })

  it('takes the blocks under it along when it moves down past a sibling with children', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
      [D, 1, 'd'],
    ])

    moveBlocks([A], 1)(ed.state, ed.view.dispatch)

    expect(rowsOf(ed.state.doc)).toEqual([
      [C, 0, 'c'],
      [D, 1, 'd'],
      [A, 0, 'a'],
      [B, 1, 'b'],
    ])
  })

  it('leaves the first top block, and the last, where they are', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    const before = rowsOf(ed.state.doc)

    moveBlocks([A], -1)(ed.state, ed.view.dispatch)
    moveBlocks([B], 1)(ed.state, ed.view.dispatch)

    expect(rowsOf(ed.state.doc)).toEqual(before)
  })

  it('moves a first child out to before its parent, and a last child out to after it', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
      [D, 1, 'd'],
    ])

    moveBlocks([B], -1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'b'],
      [C, 1, 'c'],
      [A, 0, 'a'],
      [D, 1, 'd'],
    ])

    moveBlocks([D], 1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'b'],
      [C, 1, 'c'],
      [A, 0, 'a'],
      [D, 0, 'd'],
    ])
  })

  it('moves a run of selected siblings together, in their order, either way', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [D, 0, 'd'],
    ])

    moveBlocks([B, C], 1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, D, B, C])
    moveBlocks([B, C], -1)(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc).map(([id]) => id)).toEqual([A, B, C, D])
  })

  it('keeps the cursor in the block it was in', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'bee'],
    ])
    caret(ed, 1, 2)

    moveBlocks([B], -1)(ed.state, ed.view.dispatch)

    expect(ed.state.selection.$from.index(0)).toBe(0)
    expect(ed.state.selection.$from.parentOffset).toBe(2)
  })
})

describe('indentIds and outdentIds', () => {
  it('act on the blocks named, not the cursor’s', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    caret(ed, 0, 0)

    indentIds(() => [C])(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc).map(([, depth]) => depth)).toEqual([0, 0, 1])

    outdentIds(() => [C])(ed.state, ed.view.dispatch)
    expect(rowsOf(ed.state.doc).map(([, depth]) => depth)).toEqual([0, 0, 0])
  })
})

describe('duplicateBlock', () => {
  it('copies the block and the blocks under it after them, each with a new id', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 0, 'd'],
    ])

    expect(duplicateBlock(B)(ed.state, ed.view.dispatch)).toBe(true)

    const rows = rowsOf(ed.state.doc)
    expect(rows.map(([, depth, text]) => [depth, text])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [1, 'c'],
      [0, 'b'],
      [1, 'c'],
      [0, 'd'],
    ])
    expect(rows.slice(0, 3).map(([id]) => id)).toEqual([A, B, C])
    expect(rows[5]?.[0]).toBe(D)
    expect(new Set(rows.map(([id]) => id)).size).toBe(6)
  })

  it('is refused for a block the page does not hold', () => {
    const ed = build([[A, 0, 'a']])

    expect(duplicateBlock(E)(ed.state, ed.view.dispatch)).toBe(false)
    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'a']])
  })
})

describe('the move and duplicate shortcuts (PageBlockKeys)', () => {
  const CHORD = { ctrlKey: true, shiftKey: true }

  it('move the block at the cursor and the blocks under it past a sibling, as block mode’s do', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
    caret(ed, 1, 0)

    expect(press(ed, 'ArrowUp', CHORD)).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'b'],
      [C, 1, 'c'],
      [A, 0, 'a'],
    ])

    expect(press(ed, 'ArrowDown', CHORD)).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
  })

  it('duplicate the block at the cursor with the blocks under it, right after them', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    caret(ed, 0, 0)

    expect(press(ed, 'j', CHORD)).toBe(true)
    expect(rowsOf(ed.state.doc).map(([, depth, markdown]) => [depth, markdown])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [0, 'a'],
      [1, 'b'],
      [0, 'c'],
    ])
  })
})

describe('deleteBlocks', () => {
  it('deletes the block and the blocks under it', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 0, 'd'],
    ])

    deleteBlocks([B])(ed.state, ed.view.dispatch)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [D, 0, 'd'],
    ])
  })

  it('skips a selected block that went with its parent, and deletes the rest', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])

    deleteBlocks([A, B, C])(ed.state, ed.view.dispatch)

    expect(rowsOf(ed.state.doc)).toHaveLength(1)
    expect(rowsOf(ed.state.doc)[0]?.[2]).toBe('')
  })

  it('leaves an empty block when the page’s only block goes', () => {
    const ed = build([[A, 0, 'a']])

    expect(deleteBlocks([A])(ed.state, ed.view.dispatch)).toBe(true)

    const rows = rowsOf(ed.state.doc)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[2]).toBe('')
    expect(rows[0]?.[0]).not.toBe(A)
  })

  it('does nothing for an id the page does not hold', () => {
    const ed = build([[A, 0, 'a']])

    expect(deleteBlocks([E])(ed.state, ed.view.dispatch)).toBe(false)
  })
})

describe('mergeBlock', () => {
  it('joins the block’s text to the block before, which keeps its id, wherever the cursor is', () => {
    const ed = build([
      [A, 0, 'one '],
      [B, 0, 'two'],
      [C, 0, 'three'],
    ])
    caret(ed, 2, 1)

    expect(canMerge(ed.state, B)).toBe(true)
    expect(mergeBlock(B)(ed.state, ed.view.dispatch)).toBe(true)

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'one two'],
      [C, 0, 'three'],
    ])
  })

  it('is not offered for the first block', () => {
    const ed = build([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])

    expect(canMerge(ed.state, A)).toBe(false)
    expect(mergeBlock(A)(ed.state, ed.view.dispatch)).toBe(false)
  })
})

describe('blockIdsBetween', () => {
  it('names the blocks a selection spans, in order', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])

    expect(blockIdsBetween(ed.state.doc, 4, ed.state.doc.content.size - 2)).toEqual([A, B, C])
    expect(blockIdsBetween(ed.state.doc, 4, 4)).toEqual([A])
  })
})
