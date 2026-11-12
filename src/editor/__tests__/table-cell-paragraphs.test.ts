/**
 * #6530: a table cell holds paragraphs only, the one shape its Markdown row
 * stores (`serializeTable`). A block marker typed, pasted or toggled in a cell
 * stays text in the cell, so the table saves whole. Built from the editors'
 * shared `contentExtensions`, so the schema under test is the one they run.
 */

import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ListStyleInputRule } from '@/editor/extensions/list-style-input-rule'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'

const TABLE = '| A | B |\n| --- | --- |\n| one | two |'

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

function setup(markdown = TABLE) {
  const onListStyle = vi.fn()
  const groups = contentExtensions({
    resolveTagName: (id) => id,
    resolveBlockTitle: (id) => id,
    resolveBlockStatus: () => 'active',
    resolveTagStatus: () => 'active',
    onNavigate: () => {},
    onTagClick: () => {},
    searchTags: () => [],
    onCreateTag: (name) => Promise.resolve(name),
    searchPages: () => [],
    onCreatePage: (label) => Promise.resolve(label),
    searchBlockRefs: () => [],
    listInputRules: true,
  })
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      ...Object.values(groups).flat(),
      ListStyleInputRule.configure({ onListStyle }),
    ],
    content: parse(markdown) as unknown as JSONContent,
  })
  return { editor, onListStyle }
}

/** Put the caret at the start of the cell whose text is `text`. */
function caretInCell(ed: Editor, text: string): void {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === 'paragraph' && node.textContent === text) at = pos + 1
    return at === -1
  })
  expect(at, `no cell holds ${text}`).toBeGreaterThan(0)
  ed.commands.setTextSelection(at)
}

/** Type `s` one character at a time through `handleTextInput`, as keystrokes do. */
function type(ed: Editor, s: string): void {
  const { view } = ed
  for (const ch of s) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    )
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

/** Every node type below the table's cells. */
function cellContentTypes(ed: Editor): string[] {
  const types = new Set<string>()
  ed.state.doc.descendants((node, _pos, parent) => {
    if (parent?.type.name === 'tableCell' || parent?.type.name === 'tableHeader') {
      types.add(node.type.name)
    }
    return true
  })
  return [...types]
}

/** The first data cell's text as the stored table reads back, and the table's line count. */
function storedFirstCell(ed: Editor): { text: string; lines: number } {
  const md = serialize(ed.getJSON() as DocNode)
  const table = parse(md).content?.[0]
  const cell = table?.type === 'table' ? table.content?.[1]?.content?.[0] : undefined
  const inline = cell?.content?.[0]?.content ?? []
  return {
    text: inline.map((node) => (node.type === 'text' ? node.text : '')).join(''),
    lines: md.split('\n').length,
  }
}

describe('a table cell holds paragraphs only (#6530)', () => {
  it.each([
    ['a quote', '> x'],
    ['a bullet', '- x'],
    ['a numbered item', '1. x'],
    ['a heading', '# x'],
    ['a code fence', '``` x'],
  ])('%s marker typed in a cell stays text in the cell', (_name, typed) => {
    const { editor: ed, onListStyle } = setup()
    caretInCell(ed, 'one')
    type(ed, typed)
    expect(cellContentTypes(ed)).toEqual(['paragraph'])
    expect(storedFirstCell(ed)).toEqual({ text: `${typed}one`, lines: 3 })
    expect(onListStyle).not.toHaveBeenCalled()
  })

  it.each([
    ['toggleBlockquote', (ed: Editor) => ed.commands.toggleBlockquote()],
    ['toggleBulletList', (ed: Editor) => ed.commands.toggleBulletList()],
    ['toggleOrderedList', (ed: Editor) => ed.commands.toggleOrderedList()],
    ['toggleCodeBlock', (ed: Editor) => ed.commands.toggleCodeBlock()],
    ['toggleHeading', (ed: Editor) => ed.commands.toggleHeading({ level: 1 })],
  ])('%s in a cell changes nothing', (_name, run) => {
    const { editor: ed } = setup()
    caretInCell(ed, 'one')
    run(ed)
    expect(cellContentTypes(ed)).toEqual(['paragraph'])
    expect(serialize(ed.getJSON() as DocNode)).toBe(TABLE)
  })

  it('loads a stored cell with marker text, and an earlier multi-paragraph save, as paragraphs', () => {
    const stored = '| A | B |\n| --- | --- |\n| \\> q | two > quoted - pending |'
    const { editor: ed } = setup(stored)
    expect(() => ed.state.doc.check()).not.toThrow()
    expect(cellContentTypes(ed)).toEqual(['paragraph'])
    expect(serialize(ed.getJSON() as DocNode)).toBe(stored)
  })
})
