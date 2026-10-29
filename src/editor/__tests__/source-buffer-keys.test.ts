/**
 * The *Edit as Markdown* buffer's outline keys (#5160 phase 5, #5691): the
 * keyboard catalog's indent, dedent, task-cycle, move and heading bindings
 * acting on the blocks of a Document buffer. A real TipTap editor with the
 * buffer's extensions; keys go through ProseMirror's `handleKeyDown`, so a key
 * the buffer takes is one the browser does not see.
 */

import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import { readBlocks } from '@/editor/source-buffer-blocks'
import { setCustomShortcut } from '@/lib/keyboard-config'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const A = '01J0000000000000000000000A'
const A1 = '01J000000000000000000000A1'
const B = '01J0000000000000000000000B'
const B1 = '01J000000000000000000000B1'
const B2 = '01J000000000000000000000B2'
const C = '01J0000000000000000000000C'
const N = '01J0000000000000000000000N'
const P = '01J0000000000000000000000P'

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

/** The buffer's blocks as the save reads them: each one's depth and text. */
function tree(ed: Editor): Array<[depth: number, text: string]> {
  const { text, lineIds } = readLines(ed.state.doc)
  return readBlocks(text.split('\n'), lineIds).map((block) => [block.depth, block.text])
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
  it('Tab indents the block at the cursor under its sibling wherever the cursor is, and its id stays', () => {
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

  it('the catalog’s indent chord indents every block a selection touches, not one it ends at the start of', () => {
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

  it('Shift+Tab, like the dedent chord, takes every block a selection touches a level out', () => {
    const ed = build([
      ['- p', P],
      ['  - a', A],
      ['    - a1', A1],
      ['  - b', B],
    ])
    ed.commands.setTextSelection({ from: at(ed, 1, 0), to: at(ed, 3, 3) })

    expect(press(ed, 'Tab', { shiftKey: true })).toBe(true)
    expect(lines(ed)).toEqual([
      ['- p', P],
      ['- a', A],
      ['  - a1', A1],
      ['- b', B],
    ])

    caret(ed, 1, 0)
    press(ed, 'ArrowLeft', CHORD)
    expect(lines(ed)[1]).toEqual(['- a', A])
  })

  it('Shift+Tab as WebKitGTK reports it (key Unidentified, code Tab) dedents too', () => {
    const ed = build([
      ['- p', P],
      ['  - a', A],
    ])
    caret(ed, 1, 2)

    expect(press(ed, 'Unidentified', { code: 'Tab', keyCode: 9, shiftKey: true })).toBe(true)
    expect(lines(ed)).toEqual([
      ['- p', P],
      ['- a', A],
    ])
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

  it('Tab leaves a block with no sibling before it where it is', () => {
    const rows: Line[] = [
      ['- a', A],
      ['  - a1', A1],
    ]
    const ed = build(rows)
    caret(ed, 1, 3)

    expect(press(ed, 'Tab')).toBe(true)

    expect(lines(ed)).toEqual(rows)
  })

  it('with Tab indents blocks off, Tab is left to the browser and the chord still indents', () => {
    writePreference(PREFERENCES.tabIndentsBlocks, false)
    const ed = build([
      ['- a', A],
      ['- b', B],
    ])
    caret(ed, 1, 0)

    expect(press(ed, 'Tab')).toBe(false)
    expect(lines(ed)[1]).toEqual(['- b', B])

    press(ed, 'ArrowRight', CHORD)
    expect(lines(ed)[1]).toEqual(['  - b', B])
  })

  it('Tab nests a paragraph under the list item above as a + item, so it stays a block (D4)', () => {
    const ed = build([
      ['- a', A],
      ['', null],
      ['b', B],
    ])
    caret(ed, 2, 1)

    press(ed, 'Tab')

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  + b', B],
    ])
    expect(tree(ed)).toEqual([
      [0, 'a'],
      [1, 'b'],
    ])
  })

  it('Tab nests a block under a numbered item at that item’s text column', () => {
    const ed = build([
      ['1. a', A],
      ['2. b', B],
    ])
    caret(ed, 1, 4)

    press(ed, 'Tab')

    expect(lines(ed)).toEqual([
      ['1. a', A],
      ['   1. b', B],
    ])
    expect(tree(ed)).toEqual([
      [0, 'a'],
      [1, 'b'],
    ])
  })

  it('Shift+Tab takes the siblings after a block under it, as the lines then read, written at its column', () => {
    const ed = build([
      ['p', P],
      ['', null],
      ['  - a', A],
      ['', null],
      ['  n', N],
    ])
    caret(ed, 2, 4)

    press(ed, 'Tab', { shiftKey: true })

    expect(lines(ed)).toEqual([
      ['p', P],
      ['', null],
      ['- a', A],
      ['  + n', N],
    ])
    expect(tree(ed)).toEqual([
      [0, 'p'],
      [0, 'a'],
      [1, 'n'],
    ])
  })

  it('Shift+Tab takes a + item out from under its list item as a paragraph', () => {
    const ed = build([
      ['- a', A],
      ['  + b', B],
    ])
    caret(ed, 1, 4)

    press(ed, 'Tab', { shiftKey: true })

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['b', B],
    ])
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

    // A task has no list style (D3), so the block comes back plain, a `+` item under its list item.
    expect(seen).toEqual([
      ['  - [ ] foo', B],
      ['  - [/] foo', B],
      ['  - [x] foo', B],
      ['  - [-] foo', B],
      ['  + foo', B],
    ])
    expect(lines(ed)[0]).toEqual(['- parent', A])
  })

  it('on a block’s further line, cycles that block’s checkbox', () => {
    const ed = build([
      ['a', A],
      ['more of a', null],
    ])
    caret(ed, 1, 4)

    press(ed, 'Enter', { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['- [ ] a', A],
      ['  more of a', null],
    ])
    expect(ed.state.selection.from).toBe(at(ed, 1, 6))
  })

  it('reads an ordered marker and an upper-case X, and makes a paragraph a task', () => {
    const ed = build([
      ['1. [X] done', A],
      ['', null],
      ['plain text', B],
    ])
    caret(ed, 0, 0)
    press(ed, 'Enter', { ctrlKey: true })
    caret(ed, 2, 3)
    press(ed, 'Enter', { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['- [-] done', A],
      ['- [ ] plain text', B],
    ])
  })

  it('leaves a task cycled off a paragraph, a blank line before it after a list line', () => {
    const ed = build([
      ['- a', A],
      ['- [-] b', B],
    ])
    caret(ed, 1, 7)

    press(ed, 'Enter', { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['b', B],
    ])
  })
})

describe('the heading chords', () => {
  it('turn the block at the caret into each heading, keeping its id, as Turn into does', () => {
    const ed = build([
      ['a', A],
      ['', null],
      ['b', B],
    ])
    const seen: Line[] = []
    for (const level of [1, 2, 3, 4, 5, 6]) {
      caret(ed, 2, 1)
      expect(press(ed, String(level), { ctrlKey: true, altKey: true })).toBe(true)
      seen.push(lines(ed)[2] as Line)
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6].map((level) => [`${'#'.repeat(level)} b`, B]))
    expect(lines(ed)[0]).toEqual(['a', A])
  })

  it('take a numbered block out of its list, as a heading does', () => {
    const ed = build([['1. a', A]])
    caret(ed, 0, 3)

    press(ed, '1', { ctrlKey: true, altKey: true })

    expect(lines(ed)).toEqual([['# a', A]])
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

  it('gives a paragraph moved past a list item the blank lines that keep both blocks (D1)', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['', null],
      ['c', C],
    ])
    caret(ed, 3, 0)

    press(ed, 'ArrowUp', CHORD)

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['c', C],
      ['', null],
      ['- b', B],
    ])
  })

  it('moves a paragraph with its further lines, which sit at its own column', () => {
    const ed = build([
      ['line one', A],
      ['line two', null],
      ['', null],
      ['b', B],
    ])
    caret(ed, 3, 0)

    press(ed, 'ArrowUp', CHORD)

    expect(lines(ed)).toEqual([
      ['b', B],
      ['', null],
      ['line one', A],
      ['line two', null],
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
