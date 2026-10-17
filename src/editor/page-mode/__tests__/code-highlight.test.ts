/**
 * Code highlighting (#5691) in page mode, where a document holds a page of
 * blocks: lowlight's decorations, redone only for the code blocks an edit
 * touched.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  blockId,
  caret,
  openPage,
  posIn,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { curatedLowlight } from '@/lib/lowlight-curated'

const JS = '```javascript\nconst a = 1\n```'
const PY = '```python\ndef f(): pass\n```'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

/**
 * Open `rows` with a spy on lowlight's `highlight`, cleared of the open's calls.
 * Set before the editor exists: configuring an extension copies its options.
 */
function openSpied(rows: Parameters<typeof openPage>[0]) {
  const highlight = vi.spyOn(curatedLowlight, 'highlight')
  editor = openPage(rows)
  highlight.mockClear()
  return { ed: editor, highlight }
}

/** The highlighted spans in block `index`. */
function highlighted(ed: Editor, index: number): string[] {
  const block = ed.view.dom.children[index] as HTMLElement
  return [...block.querySelectorAll('[class*="hljs-"]')].map((span) => span.className)
}

describe('page mode code highlighting', () => {
  it('highlights every code block of the page when it opens', () => {
    editor = openPage([
      [blockId(1), 0, JS],
      [blockId(2), 0, 'prose'],
      [blockId(3), 0, PY],
    ])

    expect(highlighted(editor, 0)).toContain('hljs-keyword')
    expect(highlighted(editor, 1)).toEqual([])
    expect(highlighted(editor, 2)).toContain('hljs-keyword')
  })

  it('highlights again only the code block an edit touched', () => {
    const { ed, highlight } = openSpied([
      [blockId(1), 0, JS],
      [blockId(2), 0, PY],
    ])

    caret(ed, 0, 'const a = 1'.length)
    type(ed, ';')

    expect(highlight.mock.calls).toEqual([['javascript', 'const a = 1;']])
    expect(highlighted(ed, 0)).toContain('hljs-keyword')
    expect(highlighted(ed, 1)).toContain('hljs-keyword')
  })

  it('highlights nothing for typing outside code blocks', () => {
    const { ed, highlight } = openSpied([
      [blockId(1), 0, JS],
      [blockId(2), 0, 'prose'],
    ])

    caret(ed, 1, 'prose'.length)
    type(ed, ' more')

    expect(highlight).not.toHaveBeenCalled()
    expect(highlighted(ed, 0)).toContain('hljs-keyword')
  })

  it('highlights a code block again when its language changes', () => {
    const { ed, highlight } = openSpied([[blockId(1), 0, JS]])

    ed.chain()
      .setTextSelection(posIn(ed, 0, 0))
      .updateAttributes('codeBlock', { language: 'python' })
      .run()

    expect(highlight.mock.calls).toEqual([['python', 'const a = 1']])
  })

  it('installs one highlighter in place of lowlight’s, and keeps the code block’s own plugins', () => {
    editor = openPage([[blockId(1), 0, JS]])
    const keys = editor.state.plugins.map((plugin) => (plugin as unknown as { key: string }).key)

    expect(keys.filter((key) => key.startsWith('lowlight$'))).toEqual([])
    expect(keys.filter((key) => key.startsWith('codeHighlight$'))).toHaveLength(1)
    expect(keys.filter((key) => key.startsWith('codeBlockVSCodeHandler$'))).toHaveLength(1)
  })
})
