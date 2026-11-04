/**
 * #6277 D2 — a task line's Tasks fields are read out of its text as its
 * properties (`parseDocument`, `parsePastedText`), and what writes the line
 * again keeps them where they were typed: the buffer's rewrite of a block,
 * its `key::` line edits, and page mode's paste, which keeps them as text.
 */

import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import { pastedBlocks } from '@/editor/page-mode/page-paste'
import { linesContent, readLines, sourceBufferExtensions } from '@/editor/source-buffer'
import {
  blockAt,
  blockProperty,
  cycleTaskAt,
  type SourceBlock,
  setBlockProperty,
  turnInto,
} from '@/editor/source-buffer-blocks'
import { parseDocument } from '@/editor/source-buffer-document'

const A = '01J0000000000000000000000A'
const TASK = '- [ ] a ⏫ 📅 2026-10-05'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(text: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: sourceBufferExtensions([]),
    content: linesContent({ text, lineIds: [A] }),
  })
  return editor
}

function block(ed: Editor): SourceBlock {
  const found = blockAt(ed.state.doc, 0)
  if (found === null) throw new Error('no block at line 0')
  return found
}

describe('a task line’s Tasks fields (#6277 D2)', () => {
  it('reads them as the block’s properties and counts one it cannot read', () => {
    const read = parseDocument(`${TASK} 🛫 2026-10-01`, null)

    expect(read.blocks.map(({ content, properties }) => ({ content, properties }))).toEqual([
      {
        content: 'a 🛫 2026-10-01',
        properties: [
          ['priority', '1'],
          ['due_date', '2026-10-05'],
        ],
      },
    ])
    expect(read.warnings).toEqual(['1 Tasks signifier(s) could not be read and were kept as text'])
  })

  it('keeps them on the line a rewrite of the block writes', () => {
    const ed = build(TASK)

    cycleTaskAt(0)(ed.state, ed.view.dispatch)

    expect(readLines(ed.state.doc).text).toBe('- [/] a ⏫ 📅 2026-10-05')
  })

  it('sets and clears them on the task line, as the backend writes them (#6277 D3)', () => {
    const ed = build(TASK)
    expect(blockProperty(ed.state.doc, block(ed), 'due_date')).toBe('2026-10-05')

    setBlockProperty(block(ed), 'due_date', '2026-11-01')(ed.state, ed.view.dispatch)
    expect(readLines(ed.state.doc).text).toBe('- [ ] a ⏫ 📅 2026-11-01')
    setBlockProperty(block(ed), 'scheduled_date', '2026-10-20')(ed.state, ed.view.dispatch)
    expect(readLines(ed.state.doc).text).toBe('- [ ] a ⏫ ⏳ 2026-10-20 📅 2026-11-01')
    setBlockProperty(block(ed), 'priority', null)(ed.state, ed.view.dispatch)

    expect(readLines(ed.state.doc).text).toBe('- [ ] a ⏳ 2026-10-20 📅 2026-11-01')
    expect(blockProperty(ed.state.doc, block(ed), 'priority')).toBeNull()
  })

  it('writes a `key::` line under the task line for a value no signifier carries', () => {
    const ed = build(TASK)

    setBlockProperty(block(ed), 'priority', 'A')(ed.state, ed.view.dispatch)

    expect(readLines(ed.state.doc).text).toBe(`${TASK}\n  priority:: A`)
    expect(blockProperty(ed.state.doc, block(ed), 'priority')).toBe('A')
  })

  it('go with the task: to `key::` lines when it loses its checkbox, and a done date only while done', () => {
    const cancelled = build('- [-] a ⏫ 📅 2026-10-05')
    cycleTaskAt(0)(cancelled.state, cancelled.view.dispatch)
    expect(readLines(cancelled.state.doc).text).toBe('a\n  priority:: 1\n  due_date:: 2026-10-05')
    editor?.destroy()

    const listed = build('- [ ] a ⏫ 📅 2026-10-05')
    turnInto(block(listed), 'numbered-list')(listed.state, listed.view.dispatch)
    expect(readLines(listed.state.doc).text).toBe('1. a\n   priority:: 1\n   due_date:: 2026-10-05')
    editor?.destroy()

    const done = build('- [x] a ✅ 2026-10-03 📅 2026-10-05')
    cycleTaskAt(0)(done.state, done.view.dispatch)
    expect(readLines(done.state.doc).text).toBe('- [-] a 📅 2026-10-05')
  })

  it('stay on the fence line of a task turned into code', () => {
    const ed = build('- [ ] a ⏫ 📅 2026-10-05')

    turnInto(block(ed), 'code')(ed.state, ed.view.dispatch)

    const { text } = readLines(ed.state.doc)
    const [read] = parseDocument(text, [A, null, null]).blocks
    expect({ content: read?.content, properties: read?.properties }).toEqual({
      content: '```\na\n```',
      properties: [
        ['priority', '1'],
        ['due_date', '2026-10-05'],
      ],
    })
  })

  it('stays text in page mode’s paste', () => {
    const blocks = pastedBlocks(`${TASK}\n- [ ] b`)

    const texts = (nodes: JSONContent[]): unknown[] =>
      nodes.map((node) => node.text ?? texts(node.content ?? []))
    expect(blocks.map((b) => texts(b.content))).toEqual([[['[ ] a ⏫ 📅 2026-10-05']], [['[ ] b']]])
  })
})
