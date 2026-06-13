/**
 * Slash-command insertion edge cases (T3 / #1024).
 *
 * `BlockTree.test.tsx` only asserts that `insertContent` / `insertTable` were
 * *called*, against a mock editor whose selection is pinned at pos 0. It never
 * exercises real selection-replacement, insertion at pos 0 vs mid-paragraph,
 * structural commands from a non-default block state, or insert-then-blur
 * (draft autosave). These tests drive the structural handlers through a REAL
 * minimal TipTap editor wired into the synthetic slash-command context, then
 * assert the SETTLED document — what the user would actually see.
 *
 * The editor-insert handlers (`/link`, `/tag`, `/block-ref`, `/code`,
 * `/quote`, `/table`) operate directly on `ctx.rovingEditor.editor` and never
 * touch the page store, so a real editor + the production handler is the whole
 * code path.
 */

import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import Bold from '@tiptap/extension-bold'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Paragraph from '@tiptap/extension-paragraph'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocNode } from '../../../editor/types'
import { useSlashCommandStructural } from '../useSlashCommandStructural'
import { makeSyntheticCtx } from './test-utils'

vi.mock('../../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const TABLE_EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Bold,
  Heading,
  Blockquote,
  CodeBlock,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
]

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Build a real editor whose initial doc is a single paragraph holding
 * `initialText`, wire it into a fresh synthetic ctx, and return both. Caret
 * defaults to doc-end; callers reposition via `editor.commands.setTextSelection`.
 */
function buildCtxWithEditor(initialText: string) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: TABLE_EXTENSIONS,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: initialText ? [{ type: 'text', text: initialText }] : [],
        },
      ],
    },
  })
  const { ctx } = makeSyntheticCtx()
  ctx.rovingEditor.editor = editor as unknown as typeof ctx.rovingEditor.editor
  return ctx
}

/** Text content of the first paragraph (or whatever the first block is). */
function firstParaText(): string {
  if (!editor) throw new Error('no editor')
  return editor.state.doc.child(0).textContent
}

describe('T3 — /link selection replacement', () => {
  it('replaces selected text with the `[[` trigger', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('hello world')
    if (!editor) throw new Error('no editor')

    // Select "world" (positions 7..12 in a `<p>hello world</p>` doc:
    // pos 1 is the start of text, "world" begins at offset 6 → from=7,to=12).
    editor.commands.setTextSelection({ from: 7, to: 12 })
    expect(editor.state.doc.textBetween(7, 12)).toBe('world')

    result.current.exact['link']?.(ctx, { id: 'link', label: 'Link' })

    // The selected "world" is gone; the trigger replaced it. "hello " stays.
    expect(firstParaText()).toBe('hello [[')
  })
})

describe('T3 — /tag with a multi-word selection', () => {
  it('replaces the whole multi-word selection with the `@` trigger', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('one two three')
    if (!editor) throw new Error('no editor')

    // Select "two three" (offset 4..13 → from=5, to=14).
    editor.commands.setTextSelection({ from: 5, to: 14 })
    expect(editor.state.doc.textBetween(5, 14)).toBe('two three')

    result.current.exact['tag']?.(ctx, { id: 'tag', label: 'Tag' })

    expect(firstParaText()).toBe('one @')
  })

  it('/block-ref replaces a selection with the `((` trigger', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('see other')
    if (!editor) throw new Error('no editor')

    editor.commands.setTextSelection({ from: 5, to: 10 }) // "other"
    result.current.exact['block-ref']?.(ctx, { id: 'block-ref', label: 'Block ref' })

    expect(firstParaText()).toBe('see ((')
  })
})

describe('T3 — /table at pos 0 vs mid-block', () => {
  function tableDims(): { rows: number; headerCells: number } {
    if (!editor) throw new Error('no editor')
    let rows = 0
    let headerCells = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') rows += 1
      if (node.type.name === 'tableHeader') headerCells += 1
    })
    return { rows, headerCells }
  }

  it('inserts a 3×3 table (with header row) when the caret is at pos 0', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('paragraph text')
    if (!editor) throw new Error('no editor')

    editor.commands.setTextSelection({ from: 0, to: 0 })
    result.current.exact['table']?.(ctx, { id: 'table', label: 'Table' })

    const { rows, headerCells } = tableDims()
    expect(rows).toBe(3)
    // withHeaderRow: true → the first row's 3 cells are tableHeader cells.
    expect(headerCells).toBe(3)
    // The original paragraph text survives somewhere in the doc.
    expect(editor.state.doc.textContent).toContain('paragraph text')
  })

  it('inserts a table when the caret is mid-paragraph without losing the text', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('alpha beta')
    if (!editor) throw new Error('no editor')

    // Caret between "alpha" and " beta" (offset 5 → pos 6).
    editor.commands.setTextSelection({ from: 6, to: 6 })
    result.current.exact['table']?.(ctx, { id: 'table', label: 'Table' })

    const { rows } = tableDims()
    expect(rows).toBe(3)
    expect(editor.state.doc.textContent).toContain('alpha')
    expect(editor.state.doc.textContent).toContain('beta')
  })

  it('/table-no-header inserts a table whose first row has NO header cells', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('')
    if (!editor) throw new Error('no editor')

    result.current.exact['table-no-header']?.(ctx, {
      id: 'table-no-header',
      label: 'Table (no header)',
    })

    const { rows, headerCells } = tableDims()
    expect(rows).toBe(3)
    expect(headerCells).toBe(0)
  })
})

describe('T3 — /code and /quote from a non-default block state', () => {
  it('/code toggles a paragraph WITH an active text selection into a code block', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('const x = 1')
    if (!editor) throw new Error('no editor')

    editor.commands.setTextSelection({ from: 1, to: 12 }) // whole line selected
    result.current.exact['code']?.(ctx, { id: 'code', label: 'Code' })

    // First block is now a code block carrying the original text.
    expect(editor.state.doc.child(0).type.name).toBe('codeBlock')
    expect(firstParaText()).toBe('const x = 1')
    // toggleCodeBlockSafely re-anchors the caret to doc-end (inside the block).
    expect(editor.state.selection.empty).toBe(true)
  })

  it('/quote toggles a heading block (non-default state) into a blockquote', () => {
    const { result } = renderHook(() => useSlashCommandStructural())
    editor = new Editor({
      element: document.createElement('div'),
      extensions: TABLE_EXTENSIONS,
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        ],
      },
    })
    const { ctx } = makeSyntheticCtx()
    ctx.rovingEditor.editor = editor as unknown as typeof ctx.rovingEditor.editor

    editor.commands.setTextSelection({ from: 1, to: 6 })
    result.current.exact['quote']?.(ctx, { id: 'quote', label: 'Quote' })

    // The heading is now wrapped in a blockquote (toggleBlockquote wraps the
    // current block); the title text is preserved inside.
    expect(editor.state.doc.child(0).type.name).toBe('blockquote')
    expect(editor.state.doc.textContent).toContain('Title')
  })
})

describe('T3 — insert-then-immediate-blur draft autosave state', () => {
  it('reading the editor JSON right after /link insert captures the post-insert draft', () => {
    // Draft autosave (EditableBlock blur → unmount → computeContentDelta) reads
    // `editor.getJSON()`. After a /link insert + selection replacement, that
    // snapshot must reflect the replaced text, not the pre-insert content.
    const { result } = renderHook(() => useSlashCommandStructural())
    const ctx = buildCtxWithEditor('draft body')
    if (!editor) throw new Error('no editor')

    editor.commands.setTextSelection({ from: 7, to: 11 }) // "body"
    result.current.exact['link']?.(ctx, { id: 'link', label: 'Link' })

    // Simulate the blur read: serialize-ready JSON of the live doc.
    const json = editor.getJSON() as DocNode
    const para = json.content?.[0]
    expect(para?.type).toBe('paragraph')
    const text = (para?.content ?? []).map((n) => ('text' in n ? n.text : '')).join('')
    expect(text).toBe('draft [[')
  })
})
