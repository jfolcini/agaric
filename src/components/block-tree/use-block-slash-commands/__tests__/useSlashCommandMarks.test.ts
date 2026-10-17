/**
 * Mark slash commands (#211 P0-5): `/bold` `/italic` `/code` `/strike`
 * `/highlight`. The menu opens only at a collapsed caret, so each command
 * toggles its mark as a stored mark there and the text typed next carries it.
 * Driven through a real TipTap editor.
 */

import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import Highlight from '@tiptap/extension-highlight'
import Italic from '@tiptap/extension-italic'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { afterEach, describe, expect, it } from 'vitest'

import { makeSyntheticCtx } from '@/components/block-tree/use-block-slash-commands/__tests__/test-utils'
import { useSlashCommandMarks } from '@/components/block-tree/use-block-slash-commands/useSlashCommandMarks'

const MARK_IDS = ['bold', 'italic', 'code-mark', 'strike', 'highlight'] as const

// id → TipTap mark name
const MARK_NAME: Record<(typeof MARK_IDS)[number], string> = {
  bold: 'bold',
  italic: 'italic',
  'code-mark': 'code',
  strike: 'strike',
  highlight: 'highlight',
}

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

/** A real editor holding `hello ` with the caret collapsed at its end. */
function ctxWithEditor() {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, Bold, Italic, Code, Strike, Highlight],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello ' }] }],
    },
  })
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  const { ctx } = makeSyntheticCtx()
  ctx.rovingEditor.editor = editor as unknown as typeof ctx.rovingEditor.editor
  return { ctx, editor }
}

describe('useSlashCommandMarks — registration', () => {
  it('registers all five marks as exact handlers (no prefixes)', () => {
    const { result } = renderHook(() => useSlashCommandMarks())
    for (const id of MARK_IDS) expect(result.current.exact[id]).toBeDefined()
    expect(result.current.prefix).toHaveLength(0)
  })

  it('does NOT register the code-block `code` id (that lives in structural)', () => {
    const { result } = renderHook(() => useSlashCommandMarks())
    expect(result.current.exact['code']).toBeUndefined()
  })

  it('returns a stable identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useSlashCommandMarks())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe('useSlashCommandMarks — collapsed caret: the next typed text carries the mark', () => {
  it.each(MARK_IDS)('/%s marks the text typed after it, not the text before', async (id) => {
    const { result } = renderHook(() => useSlashCommandMarks())
    const { ctx, editor: ed } = ctxWithEditor()

    await result.current.exact[id]?.(ctx, { id, label: id })

    // Typing inserts at the caret with the stored marks, as ProseMirror's
    // DOM-input path does.
    ed.view.dispatch(ed.state.tr.insertText('world'))
    expect(ed.getJSON().content?.[0]?.content).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', marks: [{ type: MARK_NAME[id] }] },
    ])
  })
})

describe('useSlashCommandMarks — no editor', () => {
  it.each(MARK_IDS)('/%s no-ops gracefully when the editor is null', (id) => {
    const { result } = renderHook(() => useSlashCommandMarks())
    const { ctx } = makeSyntheticCtx() // editor stays null
    expect(() => result.current.exact[id]?.(ctx, { id, label: id })).not.toThrow()
  })
})
