/**
 * #5689 spike — the Markdown markers revealed around the caret's inline marks,
 * on a real TipTap editor: they follow the caret, deleting one unmarks its
 * range, they never reach the stored Markdown, and the preference gates them.
 */

import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MarkdownReveal } from '@/editor/extensions/markdown-reveal'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { PREFERENCES, writePreference } from '@/lib/preferences'

let editor: Editor | null = null

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

function createEditor(markdown: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      TaskParagraph,
      Text,
      Bold,
      Italic,
      Code,
      Strike,
      History,
      MarkdownReveal,
    ],
    content: parse(markdown) as unknown as Record<string, unknown>,
  })
  return editor
}

/** The revealed markers, in document order. */
function markers(ed: Editor): string[] {
  return [...ed.view.dom.querySelectorAll('.md-reveal-marker')].map((el) => el.textContent ?? '')
}

function pressKey(ed: Editor, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key })
  return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false
}

// `plain **bold** end`: the paragraph's text starts at 1, so `bold` is 7..11.
const BOLD = 'plain **bold** end'

describe('MarkdownReveal with the preference on', () => {
  beforeEach(() => {
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  it('shows the bold markers while the caret is in the bold text and hides them once it leaves', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual(['**', '**'])
    expect(ed.view.dom.textContent).toBe('plain **bold** end')

    ed.commands.setTextSelection(14)
    expect(markers(ed)).toEqual([])
    expect(ed.view.dom.textContent).toBe('plain bold end')
  })

  it('shows the markers when the caret touches either edge of the bold text', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(7)
    expect(markers(ed)).toEqual(['**', '**'])
    ed.commands.setTextSelection(11)
    expect(markers(ed)).toEqual(['**', '**'])
  })

  it('Delete before the closing marker unbolds the whole range, and undo brings it back', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)

    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(serialize(ed.getJSON() as DocNode)).toBe('plain bold end')
    expect(markers(ed)).toEqual([])

    ed.commands.undo()
    expect(serialize(ed.getJSON() as DocNode)).toBe(BOLD)
  })

  it('draws the opening marker past a caret at the bold start, where typing is plain', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(7)
    expect(pressKey(ed, 'Backspace')).toBe(false)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(serialize(ed.getJSON() as DocNode)).toBe('plain bold end')
  })

  it('draws the closing marker before the caret once typing there stops being bold', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    expect(pressKey(ed, 'Backspace')).toBe(false)
    // Ctrl+B at the bold end: what is typed next is plain, so the caret is outside.
    ed.commands.toggleBold()
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(serialize(ed.getJSON() as DocNode)).toBe('plain bold end')
  })

  it('reveals both marks of bold inside italic', () => {
    const ed = createEditor('*a **b** c*')
    // `a b c` is 1..6; the caret after `b`.
    ed.commands.setTextSelection(4)
    expect(ed.view.dom.textContent).toBe('*a **b** c*')
  })

  it('orders markers sharing a position as the serializer writes them', () => {
    // Opens outermost first, closes innermost first.
    const nested = createEditor('***both***')
    nested.commands.setTextSelection(3)
    expect(markers(nested)).toEqual(['**', '*', '*', '**'])
    nested.destroy()
    // A close before the open beside it.
    const adjacent = createEditor('**a**~~b~~')
    adjacent.commands.setTextSelection(2)
    expect(adjacent.view.dom.textContent).toBe('**a**~~b~~')
  })

  it('never puts a marker into the document or the stored Markdown', () => {
    const markdown = 'a **bold** _it_ `code` ~~gone~~ z'
    const ed = createEditor(markdown)
    const before = serialize(ed.getJSON() as DocNode)
    // A selection across every mark reveals all of them.
    ed.commands.setTextSelection({ from: 3, to: ed.state.doc.content.size - 2 })
    expect(markers(ed)).toEqual(['**', '**', '*', '*', '`', '`', '~~', '~~'])

    expect(serialize(ed.getJSON() as DocNode)).toBe(before)
    expect(ed.state.doc.textContent).toBe('a bold it code gone z')
  })
})

describe('MarkdownReveal with the preference off', () => {
  it('draws no marker and leaves Delete to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    expect(markers(ed)).toEqual([])
    expect(pressKey(ed, 'Delete')).toBe(false)
    expect(serialize(ed.getJSON() as DocNode)).toBe(BOLD)
  })
})
