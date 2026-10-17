/**
 * Page mode's keys (#5691): depth with Tab and Shift+Tab, and the keys that
 * keep their meaning inside a block's own list or code block.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const D = blockId(4)

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Row[]): Editor {
  editor = openPage(rows)
  return editor
}

describe('Tab', () => {
  it('moves a block one level in, under the block before it, with the blocks under it', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 0, 'd'],
    ])
    caret(ed, 1, 0)

    press(ed, 'Tab')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
      [D, 0, 'd'],
    ])
  })

  it('leaves the first block, and a block already deeper than the one before, where they are', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
    ])
    caret(ed, 0, 0)
    press(ed, 'Tab')
    caret(ed, 1, 0)
    press(ed, 'Tab')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
    ])
  })

  it('moves every block a selection spans', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 2, 1) })

    press(ed, 'Tab')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 1, 'c'],
    ])
  })
})

describe('Shift+Tab', () => {
  it('moves a block one level out with the blocks under it', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
    ])
    caret(ed, 1, 1)

    press(ed, 'Tab', { shiftKey: true })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
  })

  it('leaves a top-level block where it is', () => {
    const ed = build([[A, 0, 'a']])
    caret(ed, 0, 0)

    press(ed, 'Tab', { shiftKey: true })

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'a']])
  })
})

describe('keys inside a block', () => {
  it('Enter in a list item adds an item to the same block', () => {
    const ed = build([[A, 0, '- one']])
    // Into the list item's paragraph: block, list, item, paragraph.
    ed.commands.setTextSelection(1 + 1 + 1 + 1 + 3)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, '- one\n- ']])
  })

  it('Enter in a code block adds a line to it', () => {
    const ed = build([[A, 0, '```\ncode\n```']])
    caret(ed, 0, 4)

    press(ed, 'Enter')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, '```\ncode\n\n```']])
  })

  it('Backspace at the start of a block’s second paragraph joins it within the block', () => {
    const ed = build([[A, 0, 'one\n\ntwo']])
    // Past the first paragraph: block, paragraph `one`, then into the second.
    ed.commands.setTextSelection(1 + 5 + 1)

    press(ed, 'Backspace')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'onetwo']])
  })
})
