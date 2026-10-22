/**
 * The code highlighter re-highlights only the code blocks a transaction
 * changed (#5691): typing or moving the caret elsewhere neither walks the
 * document nor runs lowlight, and the colours already drawn follow the text.
 * Both editors get it through `CodeBlockWithShortcut`.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { Node as PMNode } from '@tiptap/pm/model'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodeBlockWithShortcut } from '@/editor/use-roving-editor'

const code = (text: string) => ({
  type: 'codeBlock',
  attrs: { language: 'javascript' },
  content: [{ type: 'text', text }],
})
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

let editor: Editor

afterEach(() => {
  editor?.destroy()
  vi.restoreAllMocks()
})

/** A paragraph, a code block, a paragraph and a code block, with spies on lowlight and the walk. */
function setup() {
  const lowlight = createLowlight(common)
  // `configure` copies the options object but keeps its functions, so the spy is the one called.
  const highlight = vi.fn(lowlight.highlight)
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      CodeBlockWithShortcut.configure({ lowlight: { ...lowlight, highlight } }),
    ],
    content: {
      type: 'doc',
      content: [para('intro'), code('const a = 1'), para('middle'), code('let b = 2')],
    },
  })
  highlight.mockClear()
  const descendants = vi.spyOn(Object.getPrototypeOf(editor.state.doc) as PMNode, 'descendants')
  return { highlight, descendants }
}

/** The position inside the `n`th code block (0-based) right after its text. */
function endOfCode(n: number): number {
  const ends: number[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'codeBlock') ends.push(offset + node.nodeSize - 1)
  })
  return ends[n] ?? -1
}

const tokens = (cls: string) =>
  [...editor.view.dom.querySelectorAll(`.${cls}`)].map((el) => el.textContent)

describe('code highlighting (#5691)', () => {
  // Plugin keys are `<name>$` plus a process-wide counter, so match the prefix.
  it('installs one highlighter, not the stock lowlight plugin', () => {
    setup()
    const keys = editor.state.plugins.map((p) => (p as unknown as { key: string }).key)
    expect(keys.filter((k) => k.startsWith('lowlight$'))).toHaveLength(0)
    expect(keys.filter((k) => k.startsWith('codeHighlight$'))).toHaveLength(1)
  })

  it('moving the caret and typing outside a code block neither walks the document nor highlights', () => {
    const { highlight, descendants } = setup()
    editor.commands.setTextSelection(3)
    editor.commands.insertContent('xyz')
    editor.commands.setTextSelection(endOfCode(0))

    expect(descendants).toHaveBeenCalledTimes(0)
    expect(highlight).toHaveBeenCalledTimes(0)
    // The colours drawn before the edit moved with the text.
    expect(tokens('hljs-keyword')).toEqual(['const', 'let'])
    expect(tokens('hljs-number')).toEqual(['1', '2'])
  })

  it('typing in a code block re-highlights that block only, with its new tokens coloured', () => {
    const { highlight } = setup()
    editor.commands.setTextSelection(endOfCode(0))
    editor.commands.insertContent(' + x; return')

    expect(highlight).toHaveBeenCalledTimes(1)
    expect(highlight).toHaveBeenCalledWith('javascript', 'const a = 1 + x; return')
    expect(tokens('hljs-keyword')).toEqual(['const', 'return', 'let'])
    expect(tokens('hljs-number')).toEqual(['1', '2'])
  })

  it("changing a block's language re-highlights it in the new one", () => {
    const { highlight } = setup()
    editor.commands.setTextSelection(endOfCode(1))
    editor.commands.updateAttributes('codeBlock', { language: 'plaintext' })

    expect(highlight).toHaveBeenCalledTimes(1)
    expect(tokens('hljs-keyword')).toEqual(['const'])
  })

  // The step maps of both touch only the paragraph: the colours mapped into it must come off.
  it('a code block turned into a paragraph, or joined onto one, keeps no colours', () => {
    setup()
    editor.commands.setTextSelection(endOfCode(0))
    editor.commands.toggleCodeBlock()
    expect(editor.state.doc.child(1).type.name).toBe('paragraph')
    expect(tokens('hljs-keyword')).toEqual(['let'])

    editor.commands.setTextSelection(endOfCode(0) - 'let b = 2'.length)
    editor.commands.joinBackward()
    expect(editor.state.doc.child(2).textContent).toBe('middlelet b = 2')
    expect(tokens('hljs-keyword')).toEqual([])
  })
})
