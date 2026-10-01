/**
 * The *Edit as Markdown* buffer's outline keys (#5160 phase 5): the keyboard
 * catalog's indent, dedent, task-cycle and move bindings acting on lines. A
 * real TipTap editor with the buffer's extensions; keys go through
 * ProseMirror's `handleKeyDown`, so a key the buffer takes is one the
 * browser does not see.
 */

import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import { setCustomShortcut } from '@/lib/keyboard-config'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const A = '01J0000000000000000000000A'
const A1 = '01J000000000000000000000A1'
const B = '01J0000000000000000000000B'
const B1 = '01J000000000000000000000B1'
const B2 = '01J000000000000000000000B2'
const C = '01J0000000000000000000000C'

type Line = [text: string, id: string | null]

let editor: Editor | null = null

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  editor?.destroy()
  editor = null
  localStorage.clear()
})

function build(rows: Line[]): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: sourceBufferExtensions([]),
    content: linesContent({
      text: rows.map(([text]) => text).join('\n'),
      lineIds: rows.map(([, id]) => id),
    }),
  })
  return editor
}

function lines(ed: Editor): Line[] {
  const { text, lineIds } = readLines(ed.state.doc)
  return text.split('\n').map((line, i) => [line, lineIds[i] ?? null])
}

/** The position `offset` characters into line `index` (from 0). */
function at(ed: Editor, index: number, offset: number): number {
  let pos = 1
  for (let i = 0; i < index; i += 1) pos += ed.state.doc.child(i).nodeSize
  return pos + offset
}

function caret(ed: Editor, index: number, offset: number): void {
  ed.commands.setTextSelection(at(ed, index, offset))
}

/** Press `key`; true when the editor took it, so the browser does not act on it. */
function press(ed: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  return (
    ed.view.someProp('handleKeyDown', (f) =>
      f(ed.view, new KeyboardEvent('keydown', { key, ...init })),
    ) ?? false
  )
}

const CHORD = { ctrlKey: true, shiftKey: true }

describe('indent and dedent', () => {
  it('Tab indents the line at the cursor two spaces wherever the cursor is, and its id stays', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
    ])
    caret(ed, 1, 2)

    expect(press(ed, 'Tab')).toBe(true)

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  - b', B],
    ])
    expect(ed.state.selection.from).toBe(at(ed, 1, 4))
  })

  it('the catalog’s indent chord indents every line a selection touches, not one it ends at the start of', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['  - b1', B1],
      ['- c', C],
    ])
    ed.commands.setTextSelection({ from: at(ed, 1, 1), to: at(ed, 3, 0) })

    expect(press(ed, 'ArrowRight', CHORD)).toBe(true)

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  - b', B],
      ['    - b1', B1],
      ['- c', C],
    ])
  })

  it('Shift+Tab, like the dedent chord, removes up to two leading spaces or a tab from each line', () => {
    const ed = build([
      ['    - a', A],
      [' - b', B],
      ['\t- c', C],
      ['- d', null],
    ])
    ed.commands.setTextSelection({ from: at(ed, 0, 0), to: at(ed, 2, 3) })

    expect(press(ed, 'Tab', { shiftKey: true })).toBe(true)
    expect(lines(ed)).toEqual([
      ['  - a', A],
      ['- b', B],
      ['- c', C],
      ['- d', null],
    ])

    caret(ed, 0, 0)
    press(ed, 'ArrowLeft', CHORD)
    expect(lines(ed)[0]).toEqual(['- a', A])
  })

  it('Tab on a block takes its further lines and its children with it, ids where they were', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['  more of b', null],
      ['  - b1', B1],
      ['- c', C],
    ])
    caret(ed, 1, 3)

    press(ed, 'Tab')

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  - b', B],
      ['    more of b', null],
      ['    - b1', B1],
      ['- c', C],
    ])
  })

  it('Shift+Tab on a block’s further line dedents the block with its further lines and children', () => {
    const ed = build([
      ['- a', A],
      ['  - b', B],
      ['    more of b', null],
      ['    - b1', B1],
      ['- c', C],
    ])
    caret(ed, 2, 6)

    press(ed, 'Tab', { shiftKey: true })

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- b', B],
      ['  more of b', null],
      ['  - b1', B1],
      ['- c', C],
    ])
  })

  it('Shift+Tab leaves a top-level block where it is, and the blocks selected with it', () => {
    const rows: Line[] = [
      ['- a', A],
      ['  priority:: 1', null],
      ['  - a1', A1],
      ['- b', B],
    ]
    const ed = build(rows)
    caret(ed, 1, 4)

    expect(press(ed, 'Tab', { shiftKey: true })).toBe(true)
    ed.commands.setTextSelection({ from: at(ed, 2, 0), to: at(ed, 3, 1) })
    press(ed, 'ArrowLeft', CHORD)

    expect(lines(ed)).toEqual(rows)
  })

  it('with Tab indents blocks off, Tab is left to the browser and the chord still indents', () => {
    writePreference(PREFERENCES.tabIndentsBlocks, false)
    const ed = build([['- a', A]])
    caret(ed, 0, 0)

    expect(press(ed, 'Tab')).toBe(false)
    expect(lines(ed)).toEqual([['- a', A]])

    press(ed, 'ArrowRight', CHORD)
    expect(lines(ed)).toEqual([['  - a', A]])
  })
})

describe('cycling a task', () => {
  it('steps a nested list line through the block editor’s states in its order and back, keeping its id', () => {
    const ed = build([
      ['- parent', A],
      ['  - foo', B],
    ])
    caret(ed, 1, 5)
    const seen: Line[] = []

    for (let i = 0; i < 5; i += 1) {
      expect(press(ed, 'Enter', { ctrlKey: true })).toBe(true)
      seen.push(lines(ed)[1] as Line)
    }

    expect(seen).toEqual([
      ['  - [ ] foo', B],
      ['  - [/] foo', B],
      ['  - [x] foo', B],
      ['  - [-] foo', B],
      ['  - foo', B],
    ])
    expect(lines(ed)[0]).toEqual(['- parent', A])
  })

  it('on a block’s further line, cycles that block’s checkbox', () => {
    const ed = build([
      ['- a', A],
      ['  more of a', null],
    ])
    caret(ed, 1, 4)

    press(ed, 'Enter', { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['- [ ] a', A],
      ['  more of a', null],
    ])
  })

  it('reads an ordered marker and an upper-case X, and leaves a line that is no list item as it is', () => {
    const ed = build([
      ['1. [X] done', A],
      ['plain text', B],
    ])
    caret(ed, 0, 0)
    press(ed, 'Enter', { ctrlKey: true })
    caret(ed, 1, 3)
    press(ed, 'Enter', { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['1. [-] done', A],
      ['plain text', B],
    ])
  })
})

describe('moving lines', () => {
  const OUTLINE: Line[] = [
    ['- a', A],
    ['  - a1', A1],
    ['- b', B],
    ['  - b1', B1],
    ['    - b2', B2],
    ['- c', C],
  ]
  const B_FIRST: Line[] = [
    ['- b', B],
    ['  - b1', B1],
    ['    - b2', B2],
    ['- a', A],
    ['  - a1', A1],
    ['- c', C],
  ]

  it('up moves the line with its subtree past the sibling subtree before it, ids and caret with them; undo puts both back', () => {
    const ed = build(OUTLINE)
    caret(ed, 2, 2)

    expect(press(ed, 'ArrowUp', CHORD)).toBe(true)

    expect(lines(ed)).toEqual(B_FIRST)
    expect(ed.state.selection.from).toBe(at(ed, 0, 2))
    ed.commands.undo()
    expect(lines(ed)).toEqual(OUTLINE)
  })

  it('down moves the line with its subtree past the next sibling subtree', () => {
    const ed = build(OUTLINE)
    caret(ed, 0, 1)

    press(ed, 'ArrowDown', CHORD)

    expect(lines(ed)).toEqual(B_FIRST)
    expect(ed.state.selection.from).toBe(at(ed, 3, 1))
  })

  it('a selection over sibling subtrees moves them together', () => {
    const ed = build(OUTLINE)
    ed.commands.setTextSelection({ from: at(ed, 2, 0), to: at(ed, 5, 1) })

    press(ed, 'ArrowUp', CHORD)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['  - b1', B1],
      ['    - b2', B2],
      ['- c', C],
      ['- a', A],
      ['  - a1', A1],
    ])
  })

  it('a child moves among its siblings and stops at its parent', () => {
    const rows: Line[] = [
      ['- b', B],
      ['  - b1', B1],
      ['  - b2', B2],
      ['- c', C],
    ]
    const ed = build(rows)
    caret(ed, 2, 4)

    press(ed, 'ArrowUp', CHORD)
    const moved = lines(ed)
    expect(press(ed, 'ArrowUp', CHORD)).toBe(true)

    expect(moved).toEqual([
      ['- b', B],
      ['  - b2', B2],
      ['  - b1', B1],
      ['- c', C],
    ])
    expect(lines(ed)).toEqual(moved)
  })

  it('does nothing at the top or the bottom, and the key is still the buffer’s', () => {
    const ed = build(OUTLINE)
    caret(ed, 0, 0)
    expect(press(ed, 'ArrowUp', CHORD)).toBe(true)
    caret(ed, 5, 0)
    expect(press(ed, 'ArrowDown', CHORD)).toBe(true)

    expect(lines(ed)).toEqual(OUTLINE)
  })

  it('keeps the blank lines between two siblings between them', () => {
    const ed = build([
      ['- a', A],
      ['', null],
      ['- b', B],
    ])
    caret(ed, 2, 0)

    press(ed, 'ArrowUp', CHORD)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['', null],
      ['- a', A],
    ])
  })

  it('never moves a line into the front matter', () => {
    const rows: Line[] = [
      ['---', null],
      ['tags: [x]', null],
      ['---', null],
      ['- a', A],
      ['- b', B],
    ]
    const ed = build(rows)
    caret(ed, 3, 0)

    press(ed, 'ArrowUp', CHORD)

    expect(lines(ed)).toEqual(rows)
  })
})

describe('the catalog’s bindings', () => {
  it('a binding the user recorded replaces the default chord', () => {
    setCustomShortcut('moveBlockUp', 'Alt + Arrow Up')
    const ed = build([
      ['- a', A],
      ['- b', B],
    ])
    caret(ed, 1, 0)

    expect(press(ed, 'ArrowUp', CHORD)).toBe(false)
    expect(press(ed, 'ArrowUp', { altKey: true })).toBe(true)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- a', A],
    ])
  })
})
