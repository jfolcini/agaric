/**
 * The footnote reference node in both editors (#6033): typing `[^label]`
 * converts on the closing `]`, one undo restores the typed text, and the node
 * shows its number on the page, muted with a tooltip when nothing defines its
 * label, and focuses the definition when clicked.
 */

import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FootnoteRef } from '@/editor/extensions/footnote'
import { MarkdownReveal } from '@/editor/extensions/markdown-reveal'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import type { FootnoteNumbering } from '@/editor/footnotes'
import { parse, serialize } from '@/editor/markdown-serializer'
import {
  blockId,
  caret,
  idMinter,
  markdownOf,
  type as typeText,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { pageDocContent } from '@/editor/page-mode/page-document'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import type { DocNode } from '@/editor/types'
import { type ContentExtensionOptions, contentExtensions } from '@/editor/use-roving-editor'
import { t } from '@/lib/i18n'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const noItems = () => Promise.resolve([])

function sharedOptions(onNavigate: (id: string) => void) {
  return {
    resolveTagName: (id: string) => id,
    resolveBlockTitle: (id: string) => id,
    resolveBlockStatus: () => 'active' as const,
    resolveTagStatus: () => 'active' as const,
    onNavigate,
    onTagClick: () => {},
    searchTags: noItems,
    onCreateTag: () => Promise.resolve(''),
    searchPages: noItems,
    onCreatePage: () => Promise.resolve(''),
    searchBlockRefs: noItems,
  }
}

const editors: Editor[] = []

afterEach(() => {
  for (const ed of editors.splice(0)) ed.destroy()
})

/** Block mode's roving editor: its document and the content extensions, over one block. */
function blockEditor(
  markdown: string,
  footnotes?: ContentExtensionOptions['footnotes'],
  onNavigate: (id: string) => void = () => {},
): Editor {
  const content = contentExtensions({
    ...sharedOptions(onNavigate),
    listInputRules: true,
    ...(footnotes === undefined ? {} : { footnotes }),
  })
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      ...content.text,
      ...content.lists,
      ...content.blocks,
      ...content.inline,
      ...content.chips,
    ],
    content: parse(markdown) as unknown as Record<string, unknown>,
  })
  ed.commands.focus('end')
  editors.push(ed)
  return ed
}

function pageEditor(
  rows: ReadonlyArray<[id: string, markdown: string]>,
  onNavigate: (id: string) => void = () => {},
): Editor {
  const mintId = idMinter()
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: pageModeExtensions({ ...sharedOptions(onNavigate), placeholder: '', mintId }),
    content: pageDocContent(
      rows.map(([id, content]) => ({ id, depth: 0, content })),
      mintId,
    ),
  })
  editors.push(ed)
  return ed
}

function blockMarkdown(ed: Editor): string {
  return serialize(ed.getJSON() as DocNode)
}

function refs(ed: Editor): HTMLElement[] {
  return [...ed.view.dom.querySelectorAll<HTMLElement>('sup[data-type="footnote-ref"]')]
}

describe('typing a footnote reference (#6033)', () => {
  it('converts `[^label]` on the closing `]` in block mode', () => {
    const ed = blockEditor('see')
    typeText(ed, ' [^note-1]')
    expect(ed.state.doc.firstChild?.lastChild?.type.name).toBe('footnote_ref')
    expect(blockMarkdown(ed)).toBe('see [^note-1]')
  })

  it('one undo restores the typed text, `]` included', () => {
    const ed = blockEditor('see')
    typeText(ed, ' [^1]')
    ed.commands.undo()
    expect(ed.state.doc.textContent).toBe('see [^1]')
    expect(refs(ed)).toHaveLength(0)
  })

  it('typing on after the reference is not undone with it', () => {
    const ed = blockEditor('see')
    typeText(ed, ' [^1]')
    typeText(ed, ' more')
    ed.commands.undo()
    expect(blockMarkdown(ed)).toBe('see [^1]')
  })

  it('stays text with a space in the label', () => {
    const ed = blockEditor('x')
    typeText(ed, ' [^a b]')
    expect(ed.state.doc.textContent).toBe('x [^a b]')
  })

  it.each([
    ['a `[`', ' [^a[b]', 'x [^a[b]'],
    ['a `\\`', ' [^a\\b]', 'x [^a\\b]'],
  ])('stays text with %s in the label', (_case, typed, text) => {
    const ed = blockEditor('x')
    typeText(ed, typed)
    expect(ed.state.doc.textContent).toBe(text)
  })

  it('stays text inside inline code', () => {
    const ed = blockEditor('`a`')
    typeText(ed, '[^1]')
    expect(blockMarkdown(ed)).toBe('`a[^1]`')
  })

  it('stays text in a code block', () => {
    const ed = blockEditor('```\ncode\n```')
    typeText(ed, ' [^1]')
    expect(ed.state.doc.textContent).toBe('code [^1]')
  })

  it('converts in page mode too, and one undo restores the text', () => {
    const ed = pageEditor([[blockId(1), 'see']])
    caret(ed, 0, 3)
    typeText(ed, ' [^1]')
    expect(markdownOf(ed.state.doc.child(0))).toBe('see [^1]')
    expect(refs(ed)).toHaveLength(1)
    ed.commands.undo()
    expect(ed.state.doc.textContent).toBe('see [^1]')
    expect(refs(ed)).toHaveLength(0)
  })
})

describe('the footnote reference node (#6033)', () => {
  const numbering: FootnoteNumbering = {
    numbers: new Map([
      ['b', 1],
      ['a', 2],
    ]),
    definitions: new Map([['a', 'DEF_A']]),
  }

  it('shows the page’s number in block mode, and a click focuses the definition', () => {
    const onNavigate = vi.fn()
    const ed = blockEditor('see [^a] and [^b]', () => numbering, onNavigate)
    const [a, b] = refs(ed) as [HTMLElement, HTMLElement]
    expect(a).toHaveTextContent('2')
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('DEF_A')
    expect(b).toHaveTextContent('1')
    expect(b).toHaveClass('footnote-ref-missing')
    expect(b).toHaveAttribute('title', t('editor.footnoteMissing'))
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it('numbers page mode by first reference across its blocks, and renumbers as you type', () => {
    const onNavigate = vi.fn()
    const ed = pageEditor(
      [
        [blockId(1), 'start'],
        [blockId(2), 'see [^b] and [^a]'],
        [blockId(3), '[^a]: alpha'],
      ],
      onNavigate,
    )
    expect(refs(ed).map((el) => el.textContent)).toEqual(['1', '2', '2'])
    ;(refs(ed)[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(blockId(3))
    expect(refs(ed)[0]).toHaveClass('footnote-ref-missing')

    caret(ed, 0, 5)
    typeText(ed, ' [^a]')
    expect(refs(ed).map((el) => el.textContent)).toEqual(['1', '2', '1', '1'])
  })
})

describe('the Markdown syntax around a footnote reference (#6033)', () => {
  beforeEach(() => {
    localStorage.clear()
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  it('draws `[^` and `]` beside the reference at the caret, and nothing elsewhere', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const ed = new Editor({
      element: host,
      extensions: [Document, TaskParagraph, Text, MarkdownReveal, FootnoteRef],
      content: parse('a [^n] b') as unknown as Record<string, unknown>,
    })
    editors.push(ed)
    // Nothing is drawn while the editor is unfocused.
    ed.view.focus()
    const drawn = () =>
      [...ed.view.dom.querySelectorAll('.md-reveal-syntax-marker')].map((el) => el.textContent)
    // `a |[^n] b`, then `a [^n]| b`, then `a| [^n] b`.
    ed.commands.setTextSelection(3)
    expect(drawn()).toEqual(['[^', ']'])
    ed.commands.setTextSelection(4)
    expect(drawn()).toEqual(['[^', ']'])
    ed.commands.setTextSelection(2)
    expect(drawn()).toEqual([])
    host.remove()
  })
})
