/**
 * The *Edit as Markdown* buffer's document (#5160 phase 5): lines of plain
 * text, each under the id of the block that starts on it. A real TipTap editor
 * with the buffer's extensions; keys go through ProseMirror's `handleKeyDown`,
 * the clipboard through the view's own cut, copy and paste handlers, and a drag
 * through its dragstart and drop handlers, with only the hit test stubbed.
 */

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import { readBlocks } from '@/editor/source-buffer-blocks'
import { parseDocument } from '@/editor/source-buffer-document'

const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'
const C = '01J0000000000000000000000C'
// Blocks of another page.
const X = '01J0000000000000000000000X'
const Y = '01J0000000000000000000000Y'

type Line = [text: string, id: string | null]

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** A buffer opened with `rows` on a page whose blocks are `pageIds`, by default the rows' ids. */
function openBuffer(rows: Line[], pageIds = rows.map(([, id]) => id)): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: sourceBufferExtensions(pageIds),
    content: linesContent({
      text: rows.map(([text]) => text).join('\n'),
      lineIds: rows.map(([, id]) => id),
    }),
  })
}

function build(rows: Line[], pageIds?: Array<string | null>): Editor {
  editor = openBuffer(rows, pageIds)
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

/** The buffer's blocks as the save reads them: each one's depth, text and the id its line carries. */
function saved(ed: Editor): Array<[depth: number, content: string, id: string | null]> {
  const { text, lineIds } = readLines(ed.state.doc)
  return parseDocument(text, lineIds).blocks.map((block) => [
    block.depth,
    block.content,
    lineIds[block.line - 1] ?? null,
  ])
}

function caret(ed: Editor, index: number, offset: number): void {
  ed.commands.setTextSelection(at(ed, index, offset))
}

function press(ed: Editor, key: string, init: KeyboardEventInit = {}): void {
  ed.view.someProp('handleKeyDown', (f) =>
    f(ed.view, new KeyboardEvent('keydown', { key, ...init })),
  )
}

function clipboard(ed: Editor, type: 'cut' | 'copy' | 'paste', data = new DataTransfer()) {
  ed.view.dom.dispatchEvent(
    new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }),
  )
  return data
}

describe('the buffer document', () => {
  it('holds one line per line of the text, each under its id, and reads back as the text and ids', () => {
    const text = `- a\n  child line\n\n- b\n`
    const lineIds = [A, null, null, B, null]
    const ed = build([])
    ed.commands.setContent(linesContent({ text, lineIds }))

    expect(ed.state.doc.childCount).toBe(5)
    expect(ed.view.dom.querySelectorAll('[data-block-id]')).toHaveLength(2)
    expect(ed.view.dom.querySelector(`[data-block-id="${B}"]`)?.textContent).toBe('- b')
    expect(readLines(ed.state.doc)).toEqual({ text, lineIds })
  })

  it('shows markdown as typed: no marks, and no input rule turns a line into another node', () => {
    const ed = build([['', A]])

    ed.commands.insertContent('**bold** # not a heading ')
    ed.commands.insertContent('> ')

    expect(lines(ed)).toEqual([['**bold** # not a heading > ', A]])
    expect(ed.state.doc.child(0).type.name).toBe('line')
  })
})

describe('Enter', () => {
  it('in the middle of a line keeps the id on the first half, and a blank line makes the rest a block', () => {
    const ed = build([
      ['foo bar', A],
      ['', null],
      ['next', B],
    ])
    caret(ed, 0, 4)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['foo ', A],
      ['', null],
      ['bar', null],
      ['', null],
      ['next', B],
    ])
    expect(ed.state.selection.from).toBe(at(ed, 2, 0))
  })

  it('before a space, takes the space off the text it moves, which would indent it under the block above', () => {
    const ed = build([['foo bar', A]])
    caret(ed, 0, 3)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['foo', A],
      ['', null],
      ['bar', null],
    ])
    expect(ed.state.selection.from).toBe(at(ed, 2, 0))
  })

  it('at the end of a line keeps the id there and opens a new block after a blank line (D1)', () => {
    const ed = build([['foo', A]])
    caret(ed, 0, 3)

    press(ed, 'Enter')
    ed.commands.insertContent('bar')

    expect(lines(ed)).toEqual([
      ['foo', A],
      ['', null],
      ['bar', null],
    ])
  })

  it('at the start of a line opens a line above, and the id stays with the text where its block starts', () => {
    const ed = build([['foo', A]])
    caret(ed, 0, 0)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['', null],
      ['foo', A],
    ])
  })

  it.each([
    ['- foo', '- '],
    ['* foo', '* '],
    ['+ foo', '+ '],
    ['1. foo', '2. '],
    ['9) foo', '10) '],
    ['  - child', '  - '],
    ['- [x] done', '- [ ] '],
    ['- [ ] todo', '- [ ] '],
    // A Document line opens with one marker: the number after it is the bullet's text.
    ['- 1. text', '- '],
  ])('on %j continues the list with %j', (line, next) => {
    const ed = build([[line, A]])
    caret(ed, 0, line.length)

    press(ed, 'Enter')
    ed.commands.insertContent('x')

    expect(lines(ed)).toEqual([
      [line, A],
      [`${next}x`, null],
    ])
  })

  it.each(['- ', '-', '1. ', '- [ ] ', '  * '])(
    'on %j, a line holding only its marker, removes the marker and ends the list, a blank line after it',
    (line) => {
      const ed = build([
        ['- item', A],
        [line, null],
      ])
      caret(ed, 1, line.length)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(lines(ed)).toEqual([
        ['- item', A],
        ['', null],
        ['x', null],
      ])
    },
  )

  it('ending a numbered list in its middle leaves a blank line under the cursor too, so the items after it stay blocks of their own', () => {
    const ed = build([
      ['1. one', A],
      ['2. two', B],
      ['3. three', C],
    ])
    caret(ed, 0, 6)

    press(ed, 'Enter')
    press(ed, 'Enter')
    ed.commands.insertContent('x')

    expect(lines(ed)).toEqual([
      ['1. one', A],
      ['', null],
      ['x', null],
      ['', null],
      ['2. two', B],
      ['3. three', C],
    ])
    const { text, lineIds } = readLines(ed.state.doc)
    expect(readBlocks(text.split('\n'), lineIds).map((block) => block.text)).toEqual([
      'one',
      'x',
      'two',
      'three',
    ])
  })

  it('at the end of a task’s further line leaves the same blank line under a paragraph typed there', () => {
    const ed = build([
      ['- [ ] one', A],
      ['  more', null],
      ['2. two', B],
    ])
    caret(ed, 1, 6)

    press(ed, 'Enter')
    ed.commands.insertContent('x')

    expect(lines(ed)).toEqual([
      ['- [ ] one', A],
      ['  more', null],
      ['', null],
      ['x', null],
      ['', null],
      ['2. two', B],
    ])
    const { text, lineIds } = readLines(ed.state.doc)
    expect(readBlocks(text.split('\n'), lineIds).map((block) => block.text)).toEqual([
      'one\nmore',
      'x',
      'two',
    ])
  })

  it('at the end of a numbered item’s further line goes on with the list, and needs no blank line above the next item', () => {
    const ed = build([
      ['1. one', A],
      ['   more', null],
      ['2. two', B],
    ])
    caret(ed, 1, 7)

    press(ed, 'Enter')
    ed.commands.insertContent('x')

    expect(lines(ed)).toEqual([
      ['1. one', A],
      ['   more', null],
      ['2. x', null],
      ['2. two', B],
    ])
    const { text, lineIds } = readLines(ed.state.doc)
    expect(readBlocks(text.split('\n'), lineIds).map((block) => block.text)).toEqual([
      'one\nmore',
      'x',
      'two',
    ])
  })

  describe('makes a sibling of the block the cursor is in, at its depth, as page mode’s Enter does', () => {
    it('at the end of a plain child of a plain block', () => {
      const ed = build([
        ['parent', A],
        ['', null],
        ['  child', B],
      ])
      caret(ed, 2, 7)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(saved(ed)).toEqual([
        [0, 'parent', A],
        [1, 'child', B],
        [1, 'x', null],
      ])
    })

    it('in the middle of its text, the moved text the sibling and the first block keeping its id', () => {
      const ed = build([
        ['parent', A],
        ['', null],
        ['  foo bar', B],
      ])
      caret(ed, 2, 5)

      press(ed, 'Enter')

      expect(saved(ed)).toEqual([
        [0, 'parent', A],
        [1, 'foo', B],
        [1, 'bar', null],
      ])
      expect(ed.state.selection.from).toBe(at(ed, 4, 2))
    })

    it('on a further line of its text', () => {
      const ed = build([
        ['parent', A],
        ['', null],
        ['  child', B],
        ['  more', null],
      ])
      caret(ed, 3, 6)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(saved(ed)).toEqual([
        [0, 'parent', A],
        [1, 'child\nmore', B],
        [1, 'x', null],
      ])
    })

    it.each([
      [
        'a plain child',
        [
          ['parent', A],
          ['', null],
          ['  child', B],
        ],
        2,
      ],
      [
        'a nested list item',
        [
          ['- a', A],
          ['  - child', B],
        ],
        1,
      ],
    ] as const)(
      'at the start of the text of %s, the text moved keeps its depth',
      (_kind, rows, row) => {
        const ed = build(rows.map(([line, id]) => [line, id]))
        caret(ed, row, 2)

        press(ed, 'Enter')

        expect(saved(ed).map(([depth]) => depth)).toEqual([0, 1])
      },
    )

    it.each([
      ['a paragraph', 'foo'],
      ['a heading', '## foo'],
      ['a page property line, above every block', 'title:: Foo'],
    ])('at the top level, for %s, as a bare line after a blank one', (_kind, line) => {
      const ed = build([[line, A]])
      caret(ed, 0, line.length)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(lines(ed)).toEqual([
        [line, A],
        ['', null],
        ['x', null],
      ])
    })

    it('as a `+` item under a list block (D4), from its text’s first line', () => {
      const ed = build([
        ['- a', A],
        ['  + b', B],
      ])
      caret(ed, 1, 5)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(lines(ed)).toEqual([
        ['- a', A],
        ['  + b', B],
        ['  + x', null],
      ])
    })

    it('as a `+` item under a list block (D4), from its text’s further line', () => {
      const ed = build([
        ['- a', A],
        ['  + b', B],
        ['    more', null],
      ])
      caret(ed, 2, 8)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(lines(ed)).toEqual([
        ['- a', A],
        ['  + b', B],
        ['    more', null],
        ['  + x', null],
      ])
      expect(saved(ed)).toEqual([
        [0, 'a', A],
        [1, 'b\nmore', B],
        [1, 'x', null],
      ])
    })

    it.each([
      ['- a', '  more', '- x', 'bullet', 0],
      ['  - a', '    more', '  - x', 'bullet', 1],
      ['1. a', '   more', '2. x', 'ordered', 0],
    ] as const)(
      'with %j’s list style, from its text’s further line',
      (head, further, made, listStyle, depth) => {
        const ed = build([
          ['top', C],
          ['', null],
          [head, A],
          [further, null],
        ])
        caret(ed, 3, further.length)

        press(ed, 'Enter')
        ed.commands.insertContent('x')

        expect(lines(ed).slice(2)).toEqual([
          [head, A],
          [further, null],
          [made, null],
        ])
        const { text, lineIds } = readLines(ed.state.doc)
        const read = parseDocument(text, lineIds).blocks.slice(1)
        expect(read.map((block) => [block.depth, block.content, block.listStyle])).toEqual([
          [depth, 'a\nmore', listStyle],
          [depth, 'x', listStyle],
        ])
      },
    )

    it('with none from a task’s further line, as page mode gives none', () => {
      const ed = build([
        ['- [ ] a', A],
        ['  more', null],
      ])
      caret(ed, 1, 6)

      press(ed, 'Enter')
      ed.commands.insertContent('x')

      expect(lines(ed)).toEqual([
        ['- [ ] a', A],
        ['  more', null],
        ['', null],
        ['x', null],
      ])
    })
  })

  it('after a thematic break opens a new block after a blank line', () => {
    const ed = build([['***', A]])
    caret(ed, 0, 3)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['***', A],
      ['', null],
      ['', null],
    ])
  })

  it('in a fenced code block breaks the line, list markers and all, and after its closing fence opens a block', () => {
    const ed = build([
      ['```sh', A],
      ['- x', null],
      ['```', null],
    ])
    caret(ed, 1, 3)

    press(ed, 'Enter')
    caret(ed, 3, 3)
    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['```sh', A],
      ['- x', null],
      ['', null],
      ['```', null],
      ['', null],
      ['', null],
    ])
  })

  it('in the front matter breaks the line', () => {
    const ed = build([
      ['---', null],
      ['aliases: [a]', null],
      ['---', null],
    ])
    caret(ed, 1, 12)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['---', null],
      ['aliases: [a]', null],
      ['', null],
      ['---', null],
    ])
  })

  it('with Shift breaks the line in the same block, without a blank line or the list’s marker', () => {
    const ed = build([
      ['- foo', A],
      ['', null],
      ['bar', B],
    ])
    caret(ed, 0, 5)
    press(ed, 'Enter', { shiftKey: true })
    caret(ed, 3, 3)

    press(ed, 'Enter', { shiftKey: true })

    expect(lines(ed)).toEqual([
      ['- foo', A],
      ['', null],
      ['', null],
      ['bar', B],
      ['', null],
    ])
  })
})

describe('joining two lines (#5160 D-e)', () => {
  it('Backspace at the start of a line keeps the first line’s id, so the second block goes', () => {
    const ed = build([
      ['foo', A],
      ['bar', B],
    ])
    caret(ed, 1, 0)

    press(ed, 'Backspace')

    expect(lines(ed)).toEqual([['foobar', A]])
  })

  it('Delete at the end of a line keeps the first line’s id too', () => {
    const ed = build([
      ['foo', A],
      ['bar', B],
    ])
    caret(ed, 0, 3)

    press(ed, 'Delete')

    expect(lines(ed)).toEqual([['foobar', A]])
  })

  it('an empty line above gives way: the line joined into it keeps its own id', () => {
    const ed = build([
      ['', A],
      ['bar', B],
    ])
    caret(ed, 1, 0)

    press(ed, 'Backspace')

    expect(lines(ed)).toEqual([['bar', B]])
  })

  it('typing over a selection across two lines keeps the first line’s id', () => {
    const ed = build([
      ['foo', A],
      ['bar', B],
    ])
    ed.commands.setTextSelection({ from: at(ed, 0, 1), to: at(ed, 1, 2) })

    ed.commands.insertContent('X')

    expect(lines(ed)).toEqual([['fXr', A]])
  })

  it('undo brings the joined line back with its id', () => {
    const ed = build([
      ['foo', A],
      ['bar', B],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')

    ed.commands.undo()

    expect(lines(ed)).toEqual([
      ['foo', A],
      ['bar', B],
    ])
  })
})

/** What copying the whole of another page's buffer, opened with `rows`, puts on the clipboard. */
function copiedFromAnotherPage(rows: Line[]): DataTransfer {
  const other = openBuffer(rows)
  try {
    const last = rows.length - 1
    other.commands.setTextSelection({
      from: at(other, 0, 0),
      to: at(other, last, rows[last]?.[0].length ?? 0),
    })
    return clipboard(other, 'copy')
  } finally {
    other.destroy()
  }
}

/**
 * Send a drag event as the browser does: a mouse event carrying `data`, which
 * happy-dom has no `DragEvent` for. Hit testing needs a layout happy-dom does
 * not have, so the drop lands where `posAtCoords` is stubbed to say.
 */
function dragEvent(ed: Editor, type: string, data: DataTransfer, init: MouseEventInit = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  ed.view.dom.dispatchEvent(event)
}

/** Drop `data`, dragged from outside the buffer, at `pos`. */
function drop(ed: Editor, data: DataTransfer, pos: number): void {
  vi.spyOn(ed.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
  dragEvent(ed, 'drop', data)
}

/**
 * Drag the text from `from` to `to` and drop it at `pos`, through the view's
 * own dragstart and drop handlers; `ctrlKey` drags a copy.
 */
function drag(ed: Editor, from: number, to: number, pos: number, init: MouseEventInit = {}): void {
  ed.commands.setTextSelection({ from, to })
  vi.spyOn(ed.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
  const data = new DataTransfer()
  dragEvent(ed, 'dragstart', data)
  dragEvent(ed, 'drop', data, init)
}

describe('the clipboard', () => {
  it('copies the selected lines as text, one per line, with no id in it (D-a)', () => {
    const ed = build([
      ['- a', A],
      ['  - b', B],
    ])
    ed.commands.setTextSelection({ from: at(ed, 0, 0), to: at(ed, 1, 5) })

    const data = clipboard(ed, 'copy')

    expect(data.getData('text/plain')).toBe('- a\n  - b')
  })

  it('a line cut with its line break and pasted where a line starts moves its block', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['- c', C],
    ])
    ed.commands.setTextSelection({ from: at(ed, 1, 0), to: at(ed, 2, 0) })

    const data = clipboard(ed, 'cut')
    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- c', C],
    ])
    caret(ed, 0, 0)
    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- a', A],
      ['- c', C],
    ])
  })

  it('a line’s text cut and pasted on an empty line moves its block', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['', null],
    ])
    ed.commands.setTextSelection({ from: at(ed, 1, 0), to: at(ed, 1, 3) })

    const data = clipboard(ed, 'cut')
    caret(ed, 2, 0)
    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['- b', B],
    ])
  })

  it('a cut of a line’s start leaves the id on the rest of the line, and pasted mid-line it stays', () => {
    const ed = build([['- foo bar', A]])
    ed.commands.setTextSelection({ from: at(ed, 0, 0), to: at(ed, 0, 5) })

    const data = clipboard(ed, 'cut')
    expect(lines(ed)).toEqual([[' bar', A]])
    caret(ed, 0, 4)
    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([[' bar- foo', A]])
  })

  it('a cut of a line’s start, pasted where another line starts, carries no id there', () => {
    const ed = build([
      ['- foo bar', A],
      ['', null],
    ])
    ed.commands.setTextSelection({ from: at(ed, 0, 0), to: at(ed, 0, 5) })

    const data = clipboard(ed, 'cut')
    caret(ed, 1, 0)
    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      [' bar', A],
      ['- foo', null],
    ])
  })

  it('a copy pasted, twice, is new blocks: the line copied keeps its id', () => {
    const ed = build([
      ['- b', B],
      ['', null],
      ['', null],
    ])
    ed.commands.setTextSelection({ from: at(ed, 0, 0), to: at(ed, 0, 3) })
    const data = clipboard(ed, 'copy')

    caret(ed, 1, 0)
    clipboard(ed, 'paste', data)
    caret(ed, 2, 0)
    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- b', null],
      ['- b', null],
    ])
  })

  it('text from outside pastes as lines without ids: a ^ID in it is text, and blank lines stay (D-a)', () => {
    const ed = build([['', null]])
    const data = new DataTransfer()
    data.setData('text/plain', `- x ^${A}\n\n- y`)

    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      [`- x ^${A}`, null],
      ['', null],
      ['- y', null],
    ])
  })

  it('HTML from elsewhere pastes as its text', () => {
    const ed = build([['', null]])
    const data = new DataTransfer()
    data.setData('text/html', '<ul><li><strong>x</strong></li><li>y</li></ul>')
    data.setData('text/plain', '- **x**\n- y')

    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- **x**', null],
      ['- y', null],
    ])
  })
})

describe('lines from another page (#5160 D15)', () => {
  it('pasted from its buffer, they arrive as new blocks: none of its ids comes with them', () => {
    const data = copiedFromAnotherPage([
      ['- x', X],
      ['- y', Y],
    ])
    expect(data.getData('text/html')).toContain(`data-block-id="${X}"`)
    const ed = build([
      ['- a', A],
      ['', null],
    ])
    caret(ed, 1, 0)

    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- x', null],
      ['- y', null],
    ])
  })

  it('dropped from its buffer, they arrive as new blocks, as pasted ones do', () => {
    const data = copiedFromAnotherPage([
      ['- x', X],
      ['- y', Y],
    ])
    const ed = build([
      ['- a', A],
      ['', null],
    ])

    drop(ed, data, at(ed, 1, 0))

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- x', null],
      ['- y', null],
    ])
  })
})

describe('a cut line pasted into the page’s buffer opened again', () => {
  const cutLineB = (): DataTransfer => {
    const first = openBuffer([
      ['- a', A],
      ['- b', B],
      ['- c', C],
    ])
    try {
      first.commands.setTextSelection({ from: at(first, 1, 0), to: at(first, 2, 0) })
      return clipboard(first, 'cut')
    } finally {
      first.destroy()
    }
  }

  it('moves its block while the page still has it, though the draft reopened lacks the line', () => {
    const data = cutLineB()
    const ed = build(
      [
        ['- a', A],
        ['- c', C],
      ],
      [A, B, C],
    )
    caret(ed, 0, 0)

    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- a', A],
      ['- c', C],
    ])
  })

  it('is a new block once the page no longer has it', () => {
    const data = cutLineB()
    const ed = build([
      ['- a', A],
      ['- c', C],
    ])
    caret(ed, 0, 0)

    clipboard(ed, 'paste', data)

    expect(lines(ed)).toEqual([
      ['- b', null],
      ['- a', A],
      ['- c', C],
    ])
  })
})

describe('drag and drop', () => {
  it('a line dragged with its line break to where a line starts moves its block, and one undo takes it back', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['- c', C],
    ])

    drag(ed, at(ed, 1, 0), at(ed, 2, 0), at(ed, 0, 0))

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- a', A],
      ['- c', C],
    ])
    ed.commands.undo()
    expect(lines(ed)).toEqual([
      ['- a', A],
      ['- b', B],
      ['- c', C],
    ])
  })

  it('a line’s text dragged onto an empty line below moves its block, leaving its old line none', () => {
    const ed = build([
      ['- a', A],
      ['- b', B],
      ['', null],
    ])

    drag(ed, at(ed, 1, 0), at(ed, 1, 3), at(ed, 2, 0))

    expect(lines(ed)).toEqual([
      ['- a', A],
      ['', null],
      ['- b', B],
    ])
  })

  it('a line’s start dragged where another line starts leaves the id on what remains', () => {
    const ed = build([
      ['- foo bar', A],
      ['', null],
    ])

    drag(ed, at(ed, 0, 0), at(ed, 0, 5), at(ed, 1, 0))

    expect(lines(ed)).toEqual([
      [' bar', A],
      ['- foo', null],
    ])
  })

  it('a line dragged with Ctrl held is copied: the copy is a new block', () => {
    const ed = build([
      ['- b', B],
      ['', null],
    ])

    drag(ed, at(ed, 0, 0), at(ed, 0, 3), at(ed, 1, 0), { ctrlKey: true })

    expect(lines(ed)).toEqual([
      ['- b', B],
      ['- b', null],
    ])
  })

  it('HTML dropped from elsewhere arrives as its text: a ^ID in it is text', () => {
    const ed = build([['', null]])
    const data = new DataTransfer()
    data.setData('text/html', `<ul><li><strong>x</strong> ^${A}</li><li>y</li></ul>`)
    data.setData('text/plain', `- **x** ^${A}\n- y`)

    drop(ed, data, at(ed, 0, 0))

    expect(lines(ed)).toEqual([
      [`- **x** ^${A}`, null],
      ['- y', null],
    ])
  })
})

describe('undo', () => {
  it('takes back a run of typing at once, not a character at a time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const ed = build([['foo', A]])
      caret(ed, 0, 3)
      for (const ch of ' bar') {
        vi.advanceTimersByTime(100)
        ed.commands.insertContent(ch)
      }

      ed.commands.undo()

      expect(lines(ed)).toEqual([['foo', A]])
    } finally {
      vi.useRealTimers()
    }
  })
})
