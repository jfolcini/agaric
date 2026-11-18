/**
 * The highlight colour swatches (#6759), on the roving editor's real schema:
 * a press colours the selection, and the block saves Obsidian's form.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { HighlightColorPicker } from '@/components/editor-toolbar/HighlightColorPicker'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
})

function editorWith(content: string): Editor {
  const groups = contentExtensions({
    resolveTagName: () => 'work',
    resolveBlockTitle: () => 'Docs',
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
    extensions: [Document, ...Object.values(groups).flat()],
    content: parse(content) as unknown as JSONContent,
  })
  return editor
}

const saved = (e: Editor) => serialize(e.getJSON() as DocNode)

/** Select the characters `[from, to)` of the first paragraph's text. */
function select(e: Editor, from: number, to: number) {
  act(() => {
    e.commands.setTextSelection({ from: from + 1, to: to + 1 })
  })
}

describe('HighlightColorPicker', () => {
  it('colours the selection, and the block saves the colour’s emoji', async () => {
    const user = userEvent.setup()
    const e = editorWith('a claim here')
    select(e, 2, 7)
    render(<HighlightColorPicker editor={e} />)

    await user.click(screen.getByRole('button', { name: 'Red highlight' }))
    expect(saved(e)).toBe('a ==🔴claim== here')

    await user.click(screen.getByRole('button', { name: 'Green highlight' }))
    expect(saved(e)).toBe('a ==🟢claim== here')
  })

  it('turns a coloured highlight back to the default one', async () => {
    const user = userEvent.setup()
    const e = editorWith('==🔵note==')
    select(e, 0, 4)
    render(<HighlightColorPicker editor={e} />)

    await user.click(screen.getByRole('button', { name: 'Default highlight' }))
    expect(saved(e)).toBe('==note==')
  })

  it('marks the selection’s colour as pressed', () => {
    const e = editorWith('==🟣idea==')
    select(e, 1, 3)
    render(<HighlightColorPicker editor={e} />)

    expect(screen.getByRole('button', { name: 'Purple highlight' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Red highlight' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('is axe-clean', async () => {
    const e = editorWith('text')
    const { container } = render(<HighlightColorPicker editor={e} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
