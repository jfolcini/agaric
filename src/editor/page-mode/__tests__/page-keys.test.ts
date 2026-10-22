/**
 * Page mode's keys (#5691): depth with Tab and Shift+Tab, Shift+Tab moving out
 * as block mode's dedent does, and the keys that keep their meaning inside a
 * block's own list or code block.
 */

import { fireEvent } from '@testing-library/react'
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
import { mountNodeViews } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PREFERENCES, removePreference, writePreference } from '@/lib/preferences'
import { MAX_BLOCK_DEPTH } from '@/lib/tree-utils'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const D = blockId(4)
const E = blockId(5)
const F = blockId(6)

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  removePreference(PREFERENCES.tabIndentsBlocks)
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

  it('takes no block deeper than the backend keeps', () => {
    const rows: Row[] = Array.from({ length: MAX_BLOCK_DEPTH }, (_, depth) => [
      blockId(depth + 1),
      depth,
      `b${depth}`,
    ])
    rows.push([blockId(99), MAX_BLOCK_DEPTH - 1, 'last'])
    const ed = build(rows)
    caret(ed, MAX_BLOCK_DEPTH, 0)

    press(ed, 'Tab')

    expect(rowsOf(ed.state.doc).at(-1)).toEqual([blockId(99), MAX_BLOCK_DEPTH - 1, 'last'])
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

  it('moves a block out to just after its parent, leaving the blocks after it under the parent, as block mode', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
      [D, 1, 'd'],
      [E, 2, 'e'],
      [F, 0, 'f'],
    ])
    caret(ed, 1, 1)

    press(ed, 'Tab', { shiftKey: true })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [D, 1, 'd'],
      [E, 2, 'e'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [F, 0, 'f'],
    ])
    expect(ed.state.selection.$from.index(0)).toBe(3)
    expect(ed.state.selection.$from.parentOffset).toBe(1)
  })

  it('moves the selected siblings out together, and only those under the first one’s parent', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 1, 'c'],
      [D, 1, 'd'],
      [E, 0, 'e'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 2, 1) })

    press(ed, 'Tab', { shiftKey: true })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [D, 1, 'd'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [E, 0, 'e'],
    ])
  })

  it('stops at the first block shallower than the first one selected', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
      [D, 1, 'd'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 3, 1) })

    press(ed, 'Tab', { shiftKey: true })

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [D, 1, 'd'],
    ])
  })

  it('an undo puts the block back where it was', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 1, 'c'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Tab', { shiftKey: true })

    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
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

describe('the indent and dedent shortcuts', () => {
  const CHORD = { ctrlKey: true, shiftKey: true }

  it('indent and outdent the block at the cursor, as block mode’s do', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    caret(ed, 1, 0)

    expect(press(ed, 'ArrowRight', CHORD)).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
    ])

    expect(press(ed, 'ArrowLeft', CHORD)).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
  })

  it('with Tab indents blocks off, Tab is left to the browser and the shortcuts still indent', () => {
    writePreference(PREFERENCES.tabIndentsBlocks, false)
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    caret(ed, 1, 0)

    expect(press(ed, 'Tab')).toBe(false)
    expect(press(ed, 'Tab', { shiftKey: true })).toBe(false)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])

    press(ed, 'ArrowRight', CHORD)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
    ])
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

describe('a key on a chip in the text', () => {
  it('is the chip’s: Tab and Shift+Tab move no block, which they do from the text', () => {
    const rows: Row[] = [
      [A, 0, 'a'],
      [B, 0, `b #[${F}]`],
      [C, 1, 'c'],
      [D, 1, 'd'],
    ]
    const mounted = mountNodeViews(rows)
    editor = mounted.editor
    try {
      caret(mounted.editor, 3, 0)
      const chip = mounted.container.querySelector<HTMLElement>('[data-testid="tag-ref-chip"]')
      chip?.focus()
      expect(document.activeElement).toBe(chip)

      fireEvent.keyDown(chip as HTMLElement, { key: 'Tab' })
      expect(rowsOf(mounted.editor.state.doc)).toEqual(rows)
      fireEvent.keyDown(chip as HTMLElement, { key: 'Tab', shiftKey: true })
      expect(rowsOf(mounted.editor.state.doc)).toEqual(rows)

      mounted.editor.view.focus()
      fireEvent.keyDown(mounted.editor.view.dom, { key: 'Tab' })
      expect(rowsOf(mounted.editor.state.doc)[3]).toEqual([D, 2, 'd'])
    } finally {
      mounted.unmount()
    }
  })
})
