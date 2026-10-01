/**
 * The *Edit as Markdown* buffer's document (#5160 phase 5): lines of plain
 * text, each under the id of the block that starts on it. A real TipTap editor
 * with the buffer's extensions; keys go through ProseMirror's `handleKeyDown`
 * and the clipboard through the view's own cut, copy and paste handlers.
 */

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { linesContent, readLines, SOURCE_BUFFER_EXTENSIONS } from '@/editor/source-buffer'

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
    extensions: SOURCE_BUFFER_EXTENSIONS,
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
  it('in the middle of a line keeps the id on the first half and gives the new line none', () => {
    const ed = build([
      ['foo bar', A],
      ['next', B],
    ])
    caret(ed, 0, 3)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['foo', A],
      [' bar', null],
      ['next', B],
    ])
  })

  it('at the end of a line keeps the id there and opens a line with none', () => {
    const ed = build([['foo', A]])
    caret(ed, 0, 3)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['foo', A],
      ['', null],
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
    ['- 1. ordered', '- 2. '],
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
    'on %j, a line holding only its marker, removes the marker and ends the list',
    (line) => {
      const ed = build([
        ['- item', A],
        [line, null],
      ])
      caret(ed, 1, line.length)

      press(ed, 'Enter')

      expect(lines(ed)).toEqual([
        ['- item', A],
        ['', null],
      ])
    },
  )

  it('after a thematic break opens a plain line', () => {
    const ed = build([['* * *', A]])
    caret(ed, 0, 5)

    press(ed, 'Enter')

    expect(lines(ed)).toEqual([
      ['* * *', A],
      ['', null],
    ])
  })

  it('with Shift splits a list line without continuing the list', () => {
    const ed = build([['- foo', A]])
    caret(ed, 0, 5)

    press(ed, 'Enter', { shiftKey: true })

    expect(lines(ed)).toEqual([
      ['- foo', A],
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
