/**
 * The *Edit as Markdown* buffer's blocks (#5160 phase 5): the block at the
 * cursor and the edits the toolbar and the block menu make to its lines. A
 * real TipTap editor with the buffer's extensions, so the id rule runs on
 * every edit as it does in the buffer.
 */

import { Editor } from '@tiptap/core'
import type { Command } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import {
  blockAt,
  blockAtCursor,
  blockProperty,
  blockTypeOf,
  cyclePriority,
  deleteBlock,
  duplicateBlock,
  insertTagTrigger,
  insertTrigger,
  setBlockProperty,
  setBlockText,
  type SourceBlock,
  toggleWrap,
  turnInto,
} from '@/editor/source-buffer-blocks'
import { __resetPriorityLevelsForTests } from '@/lib/priority-levels'

const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'
const C = '01J0000000000000000000000C'

type Line = [text: string, id: string | null]

let editor: Editor | null = null

beforeEach(() => {
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  editor?.destroy()
  editor = null
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

function block(ed: Editor, index: number): SourceBlock {
  const found = blockAt(ed.state.doc, index)
  if (found === null) throw new Error(`no block at line ${index}`)
  return found
}

function run(ed: Editor, command: Command): void {
  command(ed.state, ed.view.dispatch)
}

const PAGE: Line[] = [
  ['---', null],
  ['aliases: [x]', null],
  ['---', null],
  ['- a', A],
  ['  more of a', null],
  ['  priority:: 2', null],
  ['  - b', B],
  ['    more of b', null],
  ['- c', C],
]

describe('the block at the cursor', () => {
  it('is the block a line starts, or the one whose line starts the run it is in', () => {
    const ed = build(PAGE)

    expect(blockAt(ed.state.doc, 3)).toEqual({ line: 3, end: 6, subtreeEnd: 8, id: A })
    expect(blockAt(ed.state.doc, 4)).toEqual({ line: 3, end: 6, subtreeEnd: 8, id: A })
    expect(blockAt(ed.state.doc, 5)?.line).toBe(3)
    expect(blockAt(ed.state.doc, 7)).toEqual({ line: 6, end: 8, subtreeEnd: 8, id: B })
    expect(blockAt(ed.state.doc, 8)).toEqual({ line: 8, end: 9, subtreeEnd: 9, id: C })
  })

  it('is a new list line with no id yet, and none in the front matter', () => {
    const ed = build([...PAGE, ['  - new', null]])

    expect(blockAt(ed.state.doc, 9)).toEqual({ line: 9, end: 10, subtreeEnd: 10, id: null })
    expect(blockAt(ed.state.doc, 1)).toBeNull()
  })

  it('counts a fence’s lines as its block’s own, a marker inside it starting nothing', () => {
    const ed = build([
      ['- ```', A],
      ['  - not a bullet', null],
      ['  ```', null],
      ['- b', B],
    ])

    expect(blockAt(ed.state.doc, 1)?.line).toBe(1)
    expect(block(ed, 0)).toEqual({ line: 0, end: 3, subtreeEnd: 3, id: A })
  })

  it('follows the selection’s head', () => {
    const ed = build(PAGE)
    ed.commands.setTextSelection(at(ed, 7, 2))

    expect(blockAtCursor(ed.state)?.id).toBe(B)
  })
})

describe('Turn into', () => {
  it('writes a heading after the markers, keeping the line’s id, its checkbox and its property lines', () => {
    const ed = build([
      ['- [ ] a', A],
      ['  priority:: 1', null],
      ['  - b', B],
    ])

    run(ed, turnInto(block(ed, 0), 'h2'))

    expect(lines(ed)).toEqual([
      ['- [ ] ## a', A],
      ['  priority:: 1', null],
      ['  - b', B],
    ])
    expect(blockTypeOf(ed.state.doc, block(ed, 0))).toBe('h2')
  })

  it('writes the list style as the export’s marker, and a paragraph drops it', () => {
    const ed = build([['- # a', A]])

    run(ed, turnInto(block(ed, 0), 'numbered-list'))
    expect(lines(ed)).toEqual([['- 1. a', A]])
    expect(blockTypeOf(ed.state.doc, block(ed, 0))).toBe('numbered-list')

    run(ed, turnInto(block(ed, 0), 'bullet-list'))
    expect(lines(ed)).toEqual([['- - a', A]])

    run(ed, turnInto(block(ed, 0), 'paragraph'))
    expect(lines(ed)).toEqual([['- a', A]])
  })

  it('quotes every line of the block’s text, and a code block fences it', () => {
    const ed = build([
      ['- a', A],
      ['  more', null],
      ['- c', C],
    ])

    run(ed, turnInto(block(ed, 0), 'quote'))
    expect(lines(ed)).toEqual([
      ['- > a', A],
      ['  > more', null],
      ['- c', C],
    ])

    run(ed, turnInto(block(ed, 0), 'code'))
    expect(lines(ed)).toEqual([
      ['- ```', A],
      ['  a', null],
      ['  more', null],
      ['  ```', null],
      ['- c', C],
    ])
  })

  it('escapes a first line out of a fence that would read as a list marker', () => {
    const ed = build([
      ['- ```', A],
      ['  - x', null],
      ['  ```', null],
    ])

    run(ed, turnInto(block(ed, 0), 'paragraph'))
    expect(lines(ed)).toEqual([['- \\- x', A]])
  })

  it('escapes a further line out of a quote that would read as a child bullet', () => {
    const ed = build([
      ['- > a', A],
      ['  > - x', null],
    ])

    run(ed, turnInto(block(ed, 0), 'paragraph'))

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  \\- x', null],
    ])
  })

  it('takes a further line’s escape off inside a fence, where nothing is escaped', () => {
    const ed = build([
      ['- a', A],
      ['  \\- x', null],
    ])

    run(ed, turnInto(block(ed, 0), 'code'))

    expect(lines(ed)).toEqual([
      ['- ```', A],
      ['  a', null],
      ['  - x', null],
      ['  ```', null],
    ])
  })

  it('puts the cursor at the end of the block’s line', () => {
    const ed = build([['- a', A]])

    run(ed, turnInto(block(ed, 0), 'h1'))

    expect(ed.state.selection.head).toBe(at(ed, 0, '- # a'.length))
  })
})

describe('the block’s text', () => {
  it('is replaced, its markers and property lines kept: a divider, a query', () => {
    const ed = build([
      ['- [x] a', A],
      ['  more', null],
      ['  due_date:: 2026-10-01', null],
    ])

    run(ed, setBlockText(block(ed, 0), '{{query tag:x}}'))

    expect(lines(ed)).toEqual([
      ['- [x] {{query tag:x}}', A],
      ['  due_date:: 2026-10-01', null],
    ])
  })
})

describe('property lines', () => {
  it('a new one goes under the block’s text and before its children, at its text’s column', () => {
    const ed = build([
      ['  - 1. a', A],
      ['    more', null],
      ['    - b', B],
    ])

    run(ed, setBlockProperty(block(ed, 0), 'due_date', '2026-10-01'))

    expect(lines(ed)).toEqual([
      ['  - 1. a', A],
      ['    more', null],
      ['    due_date:: 2026-10-01', null],
      ['    - b', B],
    ])
  })

  it('one the block has takes the value, by its key as the grammar matches it, and null removes it', () => {
    const ed = build([
      ['- a', A],
      ['  Due-Date:: 2026-01-01', null],
      ['- c', C],
    ])

    run(ed, setBlockProperty(block(ed, 0), 'due_date', '2026-10-01'))
    expect(lines(ed)[1]).toEqual(['  Due-Date:: 2026-10-01', null])
    expect(blockProperty(ed.state.doc, block(ed, 0), 'due_date')).toBe('2026-10-01')

    run(ed, setBlockProperty(block(ed, 0), 'due_date', null))
    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- c', C],
    ])
  })

  it('the priority steps through the block editor’s cycle: none, 1, 2, 3, none', () => {
    const ed = build([['- a', A]])
    const seen: Array<string | null> = []

    for (let i = 0; i < 4; i += 1) {
      run(ed, cyclePriority(block(ed, 0)))
      seen.push(blockProperty(ed.state.doc, block(ed, 0), 'priority'))
    }

    expect(seen).toEqual(['1', '2', '3', null])
    expect(lines(ed)).toEqual([['- a', A]])
  })
})

describe('Delete and Duplicate', () => {
  it('Delete takes the block’s lines and its children’s', () => {
    const ed = build(PAGE)

    run(ed, deleteBlock(block(ed, 3)))

    expect(lines(ed)).toEqual([...PAGE.slice(0, 3), ['- c', C]])
  })

  it('Delete of the only block leaves one empty line', () => {
    const ed = build([['- a', A]])

    run(ed, deleteBlock(block(ed, 0)))

    expect(lines(ed)).toEqual([['', null]])
  })

  it('Duplicate copies the block and its children after them, as new blocks', () => {
    const ed = build(PAGE)

    run(ed, duplicateBlock(block(ed, 6)))

    expect(lines(ed).slice(6)).toEqual([
      ['  - b', B],
      ['    more of b', null],
      ['  - b', null],
      ['    more of b', null],
      ['- c', C],
    ])
  })
})

describe('text the toolbar writes', () => {
  it('a mark wraps the selection, and again unwraps it', () => {
    const ed = build([['- a word here', A]])
    ed.commands.setTextSelection({ from: at(ed, 0, 4), to: at(ed, 0, 8) })

    run(ed, toggleWrap('**', '**'))
    expect(lines(ed)).toEqual([['- a **word** here', A]])
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('word')

    run(ed, toggleWrap('**', '**'))
    expect(lines(ed)).toEqual([['- a word here', A]])
  })

  it('a mark at a caret goes either side of it', () => {
    const ed = build([['- a', A]])
    ed.commands.setTextSelection(at(ed, 0, 3))

    run(ed, toggleWrap('<u>', '</u>'))

    expect(lines(ed)).toEqual([['- a<u></u>', A]])
    expect(ed.state.selection.head).toBe(at(ed, 0, 6))
  })

  it('[[ closes around a selection, and (( leaves it as the picker’s query', () => {
    const ed = build([['- see Notes', A]])
    ed.commands.setTextSelection({ from: at(ed, 0, 6), to: at(ed, 0, 11) })

    run(ed, insertTrigger('[[', ']]'))
    expect(lines(ed)).toEqual([['- see [[Notes]]', A]])
    expect(ed.state.selection.head).toBe(at(ed, 0, 15))

    ed.commands.setTextSelection({ from: at(ed, 0, 2), to: at(ed, 0, 5) })
    run(ed, insertTrigger('(('))
    expect(lines(ed)).toEqual([['- ((see [[Notes]]', A]])
    expect(ed.state.selection.head).toBe(at(ed, 0, 7))
  })

  it('# goes after a space, so the tag picker opens', () => {
    const ed = build([['- word', A]])
    ed.commands.setTextSelection(at(ed, 0, 6))

    run(ed, insertTagTrigger)
    expect(lines(ed)).toEqual([['- word #', A]])

    run(ed, insertTagTrigger)
    expect(lines(ed)).toEqual([['- word # #', A]])
  })
})
