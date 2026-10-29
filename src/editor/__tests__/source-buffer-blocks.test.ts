/**
 * The *Edit as Markdown* buffer's blocks (#5160 phase 5, #5691): the block at
 * the cursor and the edits the toolbar and the block menu make to its lines,
 * in the Document dialect. A real TipTap editor with the buffer's extensions,
 * so the id rule runs on every edit as it does in the buffer.
 */

import { Editor } from '@tiptap/core'
import type { Command } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'

import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import {
  blockAt,
  blockAtCursor,
  blockProperty,
  blockTaskState,
  blockTypeOf,
  cyclePriority,
  deleteBlock,
  duplicateBlock,
  frontMatterProperties,
  insertTagTrigger,
  insertTrigger,
  readBlocks,
  setBlockProperty,
  setBlockText,
  type SourceBlock,
  toggleWrap,
  turnInto,
} from '@/editor/source-buffer-blocks'

const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'
const C = '01J0000000000000000000000C'

type Line = [text: string, id: string | null]

let editor: Editor | null = null

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
  ['', null],
  ['a', A],
  ['more of a', null],
  ['  priority:: 2', null],
  ['', null],
  ['  - b', B],
  ['    more of b', null],
  ['', null],
  ['c', C],
]

describe('the block at the cursor', () => {
  it('is the block a line starts, or the one whose line starts the run it is in', () => {
    const ed = build(PAGE)

    expect(blockAt(ed.state.doc, 4)).toEqual({ line: 4, end: 7, subtreeEnd: 10, id: A })
    expect(blockAt(ed.state.doc, 5)).toEqual({ line: 4, end: 7, subtreeEnd: 10, id: A })
    expect(blockAt(ed.state.doc, 6)?.line).toBe(4)
    expect(blockAt(ed.state.doc, 9)).toEqual({ line: 8, end: 10, subtreeEnd: 10, id: B })
    expect(blockAt(ed.state.doc, 11)).toEqual({ line: 11, end: 12, subtreeEnd: 12, id: C })
  })

  it('is a new line with no id yet, and none in the front matter', () => {
    const ed = build([...PAGE, ['', null], ['  - new', null]])

    expect(blockAt(ed.state.doc, 13)).toEqual({ line: 13, end: 14, subtreeEnd: 14, id: null })
    expect(blockAt(ed.state.doc, 1)).toBeNull()
    expect(blockAt(ed.state.doc, 3)).toBeNull()
  })

  it('counts a fence’s lines as its block’s own, a marker inside it starting nothing', () => {
    const ed = build([
      ['```', A],
      ['- not a bullet', null],
      ['```', null],
      ['', null],
      ['- b', B],
    ])
    const a = { line: 0, end: 3, subtreeEnd: 3, id: A }

    expect(block(ed, 0)).toEqual(a)
    expect(blockAt(ed.state.doc, 1)).toEqual(a)
    expect(blockAt(ed.state.doc, 2)).toEqual(a)
  })

  it('in a fence typed under a block’s text, is the fence, a block of its own (D1), so its priority goes under it', () => {
    const ed = build([
      ['- a', A],
      ['  ```', null],
      ['  - x', null],
      ['  ```', null],
      ['- b', B],
    ])
    ed.commands.setTextSelection(at(ed, 2, 3))

    run(ed, cyclePriority(blockAtCursor(ed.state) as SourceBlock))

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['  ```', null],
      ['  - x', null],
      ['  ```', null],
      ['    priority:: 1', null],
      ['- b', B],
    ])
    expect(blockProperty(ed.state.doc, block(ed, 1), 'priority')).toBe('1')
  })

  it('follows the selection’s head', () => {
    const ed = build(PAGE)
    ed.commands.setTextSelection(at(ed, 9, 2))

    expect(blockAtCursor(ed.state)?.id).toBe(B)
  })

  it('reads a line as its marker says: `-` a bullet, `1.` numbered, `+` plain, `- [ ]` a task', () => {
    const ed = build([
      ['- a', A],
      ['1. b', B],
      ['  + c', C],
      ['- [x] d', null],
    ])

    expect([0, 1, 2, 3].map((line) => blockTypeOf(ed.state.doc, block(ed, line)))).toEqual([
      'bullet-list',
      'numbered-list',
      'paragraph',
      'paragraph',
    ])
    expect([0, 3].map((line) => blockTaskState(ed.state.doc, block(ed, line)))).toEqual([
      null,
      'DONE',
    ])
  })
})

describe('Turn into', () => {
  it('writes a heading after the markers, keeping the line’s id, its checkbox and its property lines', () => {
    const ed = build([
      ['- [ ] a', A],
      ['  priority:: 1', null],
      ['  + b', B],
    ])

    run(ed, turnInto(block(ed, 0), 'h2'))

    expect(lines(ed)).toEqual([
      ['- [ ] ## a', A],
      ['  priority:: 1', null],
      ['  + b', B],
    ])
    expect(blockTypeOf(ed.state.doc, block(ed, 0))).toBe('h2')
  })

  it('writes the list style as its marker, and a paragraph drops it', () => {
    const ed = build([['# a', A]])

    run(ed, turnInto(block(ed, 0), 'numbered-list'))
    expect(lines(ed)).toEqual([['1. a', A]])
    expect(blockTypeOf(ed.state.doc, block(ed, 0))).toBe('numbered-list')

    run(ed, turnInto(block(ed, 0), 'bullet-list'))
    expect(lines(ed)).toEqual([['- a', A]])

    run(ed, turnInto(block(ed, 0), 'paragraph'))
    expect(lines(ed)).toEqual([['a', A]])
  })

  it('numbers a block turned numbered on from the run before it', () => {
    const ed = build([
      ['1. a', A],
      ['- b', B],
    ])

    run(ed, turnInto(block(ed, 1), 'numbered-list'))

    expect(lines(ed)).toEqual([
      ['1. a', A],
      ['2. b', B],
    ])
  })

  it('takes a task’s checkbox off for a list kind, a task having no list style (D3)', () => {
    const ed = build([['- [ ] a', A]])

    run(ed, turnInto(block(ed, 0), 'bullet-list'))

    expect(lines(ed)).toEqual([['- a', A]])
    expect(blockTaskState(ed.state.doc, block(ed, 0))).toBeNull()
  })

  it('quotes every line of the block’s text, and a code block fences it', () => {
    const ed = build([
      ['a', A],
      ['more', null],
      ['', null],
      ['c', C],
    ])

    run(ed, turnInto(block(ed, 0), 'quote'))
    expect(lines(ed)).toEqual([
      ['> a', A],
      ['> more', null],
      ['', null],
      ['c', C],
    ])

    run(ed, turnInto(block(ed, 0), 'code'))
    expect(lines(ed)).toEqual([
      ['```', A],
      ['a', null],
      ['more', null],
      ['```', null],
      ['', null],
      ['c', C],
    ])
  })

  it('writes the callout variant the block menu picked', () => {
    const ed = build([['a', A]])

    run(ed, turnInto(block(ed, 0), 'callout', 'note'))

    expect(lines(ed)).toEqual([['> [!NOTE] a', A]])
  })

  it('escapes a first line out of a fence that would read as a list marker', () => {
    const ed = build([
      ['```', A],
      ['- x', null],
      ['```', null],
    ])

    run(ed, turnInto(block(ed, 0), 'paragraph'))
    expect(lines(ed)).toEqual([['\\- x', A]])
  })

  it('escapes a further line out of a quote that would read as a list item', () => {
    const ed = build([
      ['> a', A],
      ['> - x', null],
    ])

    run(ed, turnInto(block(ed, 0), 'paragraph'))

    expect(lines(ed)).toEqual([
      ['a', A],
      ['\\- x', null],
    ])
  })

  it('takes a further line’s escape off inside a fence, where nothing is escaped', () => {
    const ed = build([
      ['a', A],
      ['\\- x', null],
    ])

    run(ed, turnInto(block(ed, 0), 'code'))

    expect(lines(ed)).toEqual([
      ['```', A],
      ['a', null],
      ['- x', null],
      ['```', null],
    ])
  })

  it('writes a list block’s children again at the column its marker puts them, plain ones as + items (D4)', () => {
    const ed = build([
      ['p', A],
      ['', null],
      ['  child', B],
      ['', null],
      ['  - item', C],
    ])

    run(ed, turnInto(block(ed, 0), 'numbered-list'))

    expect(lines(ed)).toEqual([
      ['1. p', A],
      ['   + child', B],
      ['   - item', C],
    ])
    expect(readBlocks(...readBack(ed)).map((read) => [read.depth, read.text])).toEqual([
      [0, 'p'],
      [1, 'child'],
      [1, 'item'],
    ])
  })

  it('gives a list item turned into a paragraph the blank lines that keep it a block of its own (D1)', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['- c', C],
    ])

    run(ed, turnInto(block(ed, 1), 'paragraph'))

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['b', B],
      ['', null],
      ['- c', C],
    ])
  })

  it('puts the cursor at the end of the block’s line', () => {
    const ed = build([['a', A]])

    run(ed, turnInto(block(ed, 0), 'h1'))

    expect(ed.state.selection.head).toBe(at(ed, 0, '# a'.length))
  })
})

/** The buffer's texts and ids, as `readBlocks` takes them. */
function readBack(ed: Editor): [string[], Array<string | null>] {
  const { text, lineIds } = readLines(ed.state.doc)
  return [text.split('\n'), lineIds]
}

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

  it('a divider opening the buffer is a + item, which no front matter opens', () => {
    const ed = build([
      ['a', A],
      ['', null],
      ['b', B],
    ])

    run(ed, setBlockText(block(ed, 0), '---'))

    expect(lines(ed)).toEqual([
      ['+ ---', A],
      ['', null],
      ['b', B],
    ])
    expect(readBlocks(...readBack(ed)).map((read) => read.text)).toEqual(['---', 'b'])
  })
})

describe('property lines', () => {
  it('a new one goes under the block’s text and before its children, at its text’s column', () => {
    const ed = build([
      ['1. a', A],
      ['   more', null],
      ['   - b', B],
    ])

    run(ed, setBlockProperty(block(ed, 0), 'due_date', '2026-10-01'))

    expect(lines(ed)).toEqual([
      ['1. a', A],
      ['   more', null],
      ['   due_date:: 2026-10-01', null],
      ['   - b', B],
    ])
    expect(blockProperty(ed.state.doc, block(ed, 0), 'due_date')).toBe('2026-10-01')
  })

  it('one the block has takes the value, by its key as the grammar matches it, and null removes it', () => {
    const ed = build([
      ['a', A],
      ['  Due-Date:: 2026-01-01', null],
      ['', null],
      ['c', C],
    ])

    run(ed, setBlockProperty(block(ed, 0), 'due_date', '2026-10-01'))
    expect(lines(ed)[1]).toEqual(['  Due-Date:: 2026-10-01', null])
    expect(blockProperty(ed.state.doc, block(ed, 0), 'due_date')).toBe('2026-10-01')

    run(ed, setBlockProperty(block(ed, 0), 'due_date', null))
    expect(lines(ed)).toEqual([
      ['a', A],
      ['', null],
      ['c', C],
    ])
  })

  it('the priority steps through the block editor’s cycle: none, 1, 2, 3, none', () => {
    const ed = build([['a', A]])
    const seen: Array<string | null> = []

    for (let i = 0; i < 4; i += 1) {
      run(ed, cyclePriority(block(ed, 0)))
      seen.push(blockProperty(ed.state.doc, block(ed, 0), 'priority'))
    }

    expect(seen).toEqual(['1', '2', '3', null])
    expect(lines(ed)).toEqual([['a', A]])
  })
})

describe('Delete and Duplicate', () => {
  it('Delete takes the block’s lines and its children’s', () => {
    const ed = build(PAGE)

    run(ed, deleteBlock(block(ed, 4)))

    expect(lines(ed)).toEqual([...PAGE.slice(0, 4), ...PAGE.slice(10)])
  })

  it('Delete of a parent’s first numbered child numbers the next one from 1, which a `2.` under the parent’s text would be a line of', () => {
    const ed = build([
      ['3. three', A],
      ['   1. a', B],
      ['   2. b', C],
      ['4. four', null],
    ])

    run(ed, deleteBlock(block(ed, 1)))

    expect(lines(ed)).toEqual([
      ['3. three', A],
      ['   1. b', C],
      ['4. four', null],
    ])
    const { text, lineIds } = readLines(ed.state.doc)
    expect(readBlocks(text.split('\n'), lineIds).map((read) => [read.depth, read.text])).toEqual([
      [0, 'three'],
      [1, 'b'],
      [0, 'four'],
    ])
  })

  it('Delete of a numbered block writes the numbered blocks after it again from where it stood, and no others', () => {
    const ed = build([
      ['1. one', A],
      ['2. two', B],
      ['3. three', C],
      ['', null],
      ['para', null],
    ])

    run(ed, deleteBlock(block(ed, 0)))

    expect(lines(ed)).toEqual([
      ['1. two', B],
      ['2. three', C],
      ['', null],
      ['para', null],
    ])
  })

  it('Delete of the only block leaves one empty line', () => {
    const ed = build([['- a', A]])

    run(ed, deleteBlock(block(ed, 0)))

    expect(lines(ed)).toEqual([['', null]])
  })

  it('Duplicate copies the block and its children after them, as new blocks', () => {
    const ed = build(PAGE)

    run(ed, duplicateBlock(block(ed, 8)))

    expect(lines(ed).slice(8)).toEqual([
      ['  - b', B],
      ['    more of b', null],
      ['  - b', null],
      ['    more of b', null],
      ['', null],
      ['c', C],
    ])
  })

  it('Duplicate puts a blank line before a paragraph’s copy, so it is a block of its own (D1)', () => {
    const ed = build([['a', A]])

    run(ed, duplicateBlock(block(ed, 0)))

    expect(lines(ed)).toEqual([
      ['a', A],
      ['', null],
      ['a', null],
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

describe('readBlocks', () => {
  it('reads each block under the front matter with its depth, list style, task, text and properties', () => {
    const texts = [
      '---',
      'aliases: [gs]',
      '---',
      '',
      '- [x] Done **well**',
      '  further line',
      '  priority:: 1',
      '  - child',
      '    1. grandchild',
      '',
      '\\- not a marker',
      '',
      'a bare paragraph',
      'that runs on',
      '',
    ]
    const ids = [null, null, null, null, A, null, null, B, null, null, C, null, null, null, null]

    expect(readBlocks(texts, ids)).toEqual([
      {
        depth: 0,
        listStyle: 'none',
        taskState: 'DONE',
        text: 'Done **well**\nfurther line',
        properties: [['priority', '1']],
      },
      { depth: 1, listStyle: 'bullet', taskState: null, text: 'child', properties: [] },
      { depth: 2, listStyle: 'ordered', taskState: null, text: 'grandchild', properties: [] },
      { depth: 0, listStyle: 'none', taskState: null, text: '- not a marker', properties: [] },
      {
        depth: 0,
        listStyle: 'none',
        taskState: null,
        text: 'a bare paragraph\nthat runs on',
        properties: [],
      },
    ])
  })

  it('reads no block from an empty buffer', () => {
    expect(readBlocks([''], [null])).toEqual([])
  })
})

describe('frontMatterProperties', () => {
  it('reads each key: value line, a key: | value from the lines under it', () => {
    const texts = ['---', 'aliases: [a, b]', 'note: |', '  two', '  lines', '---', '- block']

    expect(frontMatterProperties(texts)).toEqual([
      ['aliases', '[a, b]'],
      ['note', 'two lines'],
    ])
  })

  it('reads nothing without front matter', () => {
    expect(frontMatterProperties(['- block', 'key: value'])).toEqual([])
  })
})
