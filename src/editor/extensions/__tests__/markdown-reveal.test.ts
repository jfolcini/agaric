/**
 * #5689 — the Markdown markers revealed around the caret's inline marks, on a
 * real TipTap editor: they follow the caret, deleting one unmarks its range,
 * crossing one changes only what typing carries, they never reach the stored
 * Markdown or the undo history, and the preference gates them.
 */

import { type AnyExtension, Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import Highlight from '@tiptap/extension-highlight'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { undoDepth } from '@tiptap/pm/history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  vi.useRealTimers()
})

function createEditor(source: string, more: AnyExtension[] = []): Editor {
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
      ...more,
    ],
    content: parse(source) as unknown as Record<string, unknown>,
  })
  return editor
}

/** The revealed markers, in document order. */
function markers(ed: Editor): string[] {
  return [...ed.view.dom.querySelectorAll('.md-reveal-marker')].map((el) => el.textContent ?? '')
}

function pressKey(ed: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, ...init })
  return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false
}

/** Type at the caret as the DOM would: the stored marks, else the position's, carry over. */
function type(ed: Editor, text: string): void {
  ed.view.dispatch(ed.state.tr.insertText(text))
}

function markdown(ed: Editor): string {
  return serialize(ed.getJSON() as DocNode)
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
    expect(markdown(ed)).toBe('plain bold end')
    expect(markers(ed)).toEqual([])

    ed.commands.undo()
    expect(markdown(ed)).toBe(BOLD)
  })

  it('Delete before the opening marker unbolds a run that spans differently formatted text', () => {
    const ed = createEditor('plain **a *b* c** end')
    ed.commands.setTextSelection(7)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('plain a *b* c end')
  })

  it('leaves Delete over a selection to the editor, even from a marked run', () => {
    const ed = createEditor(BOLD)
    // `plain **bold[** e]nd`: the selection starts at the bold end, where a marker is drawn.
    ed.commands.setTextSelection({ from: 11, to: 13 })
    expect(markers(ed)).toEqual(['**', '**'])
    pressKey(ed, 'Delete')
    expect(markdown(ed)).toBe('plain **bold**nd')
  })

  it('draws the opening marker past a caret at the bold start, where typing is plain', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(7)
    expect(pressKey(ed, 'Backspace')).toBe(false)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('plain bold end')
  })

  it('draws the closing marker before the caret once typing there stops being bold', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    expect(pressKey(ed, 'Backspace')).toBe(false)
    // Ctrl+B at the bold end: what is typed next is plain, so the caret is outside.
    ed.commands.toggleBold()
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('plain bold end')
  })

  it('Backspace after the opening marker at the block start unbolds the range', () => {
    const ed = createEditor('**bold** rest')
    ed.commands.setTextSelection(1)
    expect(ed.view.dom.textContent).toBe('**bold** rest')
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('bold rest')
  })

  it('a deleteContentBackward input after a marker unbolds the range and cancels the input', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    ed.commands.toggleBold()
    const input = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      cancelable: true,
    })
    ed.view.dom.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    expect(markdown(ed)).toBe('plain bold end')
  })

  it('a deleteContentBackward input with no marker before the caret is left to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(10)
    const input = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      cancelable: true,
    })
    ed.view.dom.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(false)
    expect(markdown(ed)).toBe(BOLD)
  })

  it('ArrowRight at the bold end steps past the closing marker, so typing there is plain', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(ed.state.selection.from).toBe(11)
    expect(ed.view.dom.textContent).toBe('plain **bold** end')
    type(ed, 'X')
    expect(markdown(ed)).toBe('plain **bold**X end')
  })

  it('ArrowLeft past a closing marker steps back inside the bold', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    pressKey(ed, 'ArrowRight')
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    type(ed, 'X')
    expect(markdown(ed)).toBe('plain **boldX** end')
  })

  it('ArrowRight at the bold start steps inside the opening marker', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(7)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    type(ed, 'X')
    expect(markdown(ed)).toBe('plain **Xbold** end')
  })

  it('ArrowLeft onto the bold end from outside lands past the closing marker', () => {
    const ed = createEditor(BOLD)
    // `plain **bold** |end`
    ed.commands.setTextSelection(12)
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(11)
    type(ed, 'X')
    expect(markdown(ed)).toBe('plain **bold**X end')
  })

  it('ArrowLeft onto the bold start from inside lands inside the opening marker', () => {
    const ed = createEditor(BOLD)
    // `plain **b|old**`
    ed.commands.setTextSelection(8)
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(7)
    type(ed, 'X')
    expect(markdown(ed)).toBe('plain **Xbold** end')
  })

  it('leaves an arrow with no marker on its side to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    expect(pressKey(ed, 'ArrowLeft')).toBe(false)
    expect(pressKey(ed, 'ArrowRight')).toBe(false)
    ed.commands.setTextSelection(3)
    expect(pressKey(ed, 'ArrowLeft')).toBe(false)
  })

  it('crosses nested markers one at a time, innermost first', () => {
    const ed = createEditor('***both*** after')
    // `both` is 1..5; the caret at its end types bold italic.
    ed.commands.setTextSelection(5)
    pressKey(ed, 'ArrowRight')
    type(ed, 'X')
    expect(markdown(ed)).toBe('***both*X** after')
    ed.commands.undo()
    ed.commands.setTextSelection(5)
    pressKey(ed, 'ArrowRight')
    pressKey(ed, 'ArrowRight')
    type(ed, 'Y')
    expect(markdown(ed)).toBe('***both***Y after')
  })

  it('lets the arrow move on when the mark cannot be typed there', () => {
    const ed = createEditor('a **b**')
    // Code excludes bold: with code stored at the bold start, crossing into the bold cannot add it.
    ed.commands.setTextSelection(3)
    ed.commands.toggleCode()
    expect(pressKey(ed, 'ArrowRight')).toBe(false)
  })

  it('crossing a marker adds no undo step', () => {
    const ed = createEditor(BOLD)
    type(ed, 'x')
    const depth = undoDepth(ed.state)
    ed.commands.setTextSelection(11)
    pressKey(ed, 'ArrowRight')
    pressKey(ed, 'ArrowLeft')
    expect(undoDepth(ed.state)).toBe(depth)
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
    const source = 'a **bold** _it_ `code` ~~gone~~ z'
    const ed = createEditor(source)
    const before = markdown(ed)
    // A selection across every mark reveals all of them.
    ed.commands.setTextSelection({ from: 3, to: ed.state.doc.content.size - 2 })
    expect(markers(ed)).toEqual(['**', '**', '*', '*', '`', '`', '~~', '~~'])

    expect(markdown(ed)).toBe(before)
    expect(ed.state.doc.textContent).toBe('a bold it code gone z')
  })

  it('draws the markers from the first state, before any edit', () => {
    // The initial caret is at the block start, inside the opening marker.
    const ed = createEditor('**bold** rest')
    expect(markers(ed)).toEqual(['**', '**'])
  })

  it('keeps the drawn markers when the caret moves inside the same run', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(8)
    const before = [...ed.view.dom.querySelectorAll('.md-reveal-marker')]
    ed.commands.setTextSelection(9)
    const after = [...ed.view.dom.querySelectorAll('.md-reveal-marker')]
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('hides each marker from screen readers and in-page find', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    const drawn = [...ed.view.dom.querySelectorAll('[data-testid="md-reveal-marker"]')]
    expect(drawn).toHaveLength(2)
    for (const marker of drawn) {
      expect(marker.getAttribute('aria-hidden')).toBe('true')
      expect(marker.hasAttribute('data-find-skip')).toBe(true)
    }
  })

  it('leaves modified keys and other keys to the editor, even beside a marker', () => {
    const ed = createEditor(BOLD)
    // `plain **bold|** end`: the closing marker is after the caret.
    ed.commands.setTextSelection(11)
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(pressKey(ed, 'ArrowRight', { [modifier]: true })).toBe(false)
      expect(pressKey(ed, 'Delete', { [modifier]: true })).toBe(false)
    }
    expect(pressKey(ed, 'x')).toBe(false)
    expect(markdown(ed)).toBe(BOLD)
  })

  it('Delete and Backspace act on the nearest of two markers at the caret', () => {
    const ed = createEditor('***both*** after')
    // `***both|***`: both closing markers after the caret, italic's nearest.
    ed.commands.setTextSelection(5)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('**both** after')
    ed.commands.undo()
    ed.commands.setTextSelection(5)
    // `***both***|`: both before the caret, bold's nearest.
    pressKey(ed, 'ArrowRight')
    pressKey(ed, 'ArrowRight')
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('*both* after')
  })

  it('Delete and Backspace act on the nearest of two opening markers at the caret', () => {
    // `a |**~~x~~**`: both opening markers after the caret, bold's nearest.
    const outside = createEditor('a **~~x~~**')
    outside.commands.setTextSelection(3)
    expect(pressKey(outside, 'Delete')).toBe(true)
    expect(markdown(outside)).toBe('a ~~x~~')
    outside.destroy()
    // `**~~|x~~** after`: both before the caret at the block start, strike's nearest.
    const inside = createEditor('**~~x~~** after')
    inside.commands.setTextSelection(1)
    expect(pressKey(inside, 'Backspace')).toBe(true)
    expect(markdown(inside)).toBe('**x** after')
  })

  it('places only the markers at the caret by its stored marks', () => {
    const ed = createEditor('**~~both~~** after')
    ed.commands.setTextSelection(3)
    // Typing at the caret leaves the bold; the run's own end still closes strike first.
    ed.commands.toggleBold()
    expect(ed.view.dom.textContent).toBe('**~~both~~** after')
  })

  it('reveals no highlight, and an arrow onto its edge is left to the editor', () => {
    const ed = createEditor('==hi== z', [Highlight])
    ed.commands.setTextSelection(2)
    expect(markers(ed)).toEqual([])
    // `==hi== |z` and `==h|i==`: onto the highlight's end and start.
    ed.commands.setTextSelection(4)
    expect(pressKey(ed, 'ArrowLeft')).toBe(false)
    ed.destroy()
    const after = createEditor('hi ==lit==', [Highlight])
    after.commands.setTextSelection(5)
    expect(pressKey(after, 'ArrowLeft')).toBe(false)
  })

  it('draws a marker at the edge of highlighted text inside the highlight, outside the bold', () => {
    const ed = createEditor('==**hi**== z', [Highlight])
    ed.commands.setTextSelection(2)
    const marker = ed.view.dom.querySelector('.md-reveal-marker')
    expect(marker?.parentElement?.tagName).toBe('MARK')
    expect(marker?.closest('strong')).toBeNull()
  })

  it('keeps the markers in place while an IME composes, and redraws them once it ends', () => {
    vi.useFakeTimers()
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual(['**', '**'])
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    expect(ed.view.composing).toBe(true)
    // The caret leaves the bold run while the composition is open.
    ed.commands.setTextSelection(14)
    expect(markers(ed)).toEqual(['**', '**'])
    ed.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }))
    vi.runAllTimers()
    expect(markers(ed)).toEqual([])
  })

  it('does not redraw into a composition that starts right after one ends', () => {
    vi.useFakeTimers()
    const ed = createEditor(BOLD)
    // `plain **bold**| end`: past the closing marker, so typing carries stored marks.
    ed.commands.setTextSelection(11)
    pressKey(ed, 'ArrowRight')
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    ed.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }))
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    vi.runAllTimers()
    expect(ed.view.composing).toBe(true)
  })

  it('draws no marker from the next transaction on once the preference is turned off', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual(['**', '**'])
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    ed.commands.setTextSelection(10)
    expect(markers(ed)).toEqual([])
  })
})

describe('MarkdownReveal with the preference off', () => {
  it('draws no marker and leaves Delete and the arrows to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(11)
    expect(markers(ed)).toEqual([])
    expect(pressKey(ed, 'Delete')).toBe(false)
    expect(pressKey(ed, 'ArrowRight')).toBe(false)
    ed.commands.setTextSelection(12)
    expect(pressKey(ed, 'ArrowLeft')).toBe(false)
    expect(markdown(ed)).toBe(BOLD)
  })
})
