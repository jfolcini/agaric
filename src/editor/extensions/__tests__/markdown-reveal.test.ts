/**
 * #5689 — the Markdown syntax revealed around the caret, on a real TipTap
 * editor: inline marks' markers, a heading's `#` run and a link's `[` and
 * `](url)` follow the caret, deleting one unmarks its range, lowers its
 * heading or unlinks, crossing one changes only what typing carries, nothing
 * reaches the stored Markdown or the undo history, and the preference gates it
 * all.
 */

import { type AnyExtension, Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { undoDepth } from '@tiptap/pm/history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlockLink } from '@/editor/extensions/block-link'
import { BlockRef } from '@/editor/extensions/block-ref'
import { ExternalLink } from '@/editor/extensions/external-link'
import { ListMarkerDecoration, setListMarkerMeta } from '@/editor/extensions/list-marker-decoration'
import { MarkdownReveal } from '@/editor/extensions/markdown-reveal'
import { TagRef } from '@/editor/extensions/tag-ref'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { parse, serialize } from '@/editor/markdown-serializer'
import { isOutsideHeadingMarker, markerBesideCaret } from '@/editor/revealed-markers'
import type { DocNode } from '@/editor/types'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const editors: Array<{ editor: Editor; host: HTMLElement }> = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const { editor, host } of editors.splice(0)) {
    editor.destroy()
    host.remove()
  }
  vi.useRealTimers()
})

function createEditor(source: string, more: AnyExtension[] = []): Editor {
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
    extensions: [
      Document,
      TaskParagraph,
      Text,
      Bold,
      Italic,
      Code,
      Strike,
      Heading,
      ExternalLink,
      History,
      MarkdownReveal,
      ...more,
    ],
    content: parse(source) as unknown as Record<string, unknown>,
  })
  editors.push({ editor, host })
  return editor
}

/** The revealed markers, in document order, as the user reads them. */
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

/** Type as the keyboard does: the editor's text-input handlers first, else an insert. */
function typeKey(ed: Editor, text: string): boolean {
  const { from, to } = ed.state.selection
  const handled =
    ed.view.someProp('handleTextInput', (f) =>
      f(ed.view, from, to, text, () => ed.state.tr.insertText(text, from, to)),
    ) ?? false
  if (!handled) type(ed, text)
  return handled
}

/** Give the markers drawn at `pos` the horizontal extents `boxes`, in document order: jsdom lays nothing out. */
function layOut(ed: Editor, pos: number, boxes: Array<[number, number]>): void {
  const drawn = [...ed.view.dom.querySelectorAll('.md-reveal-marker')].filter(
    (el) => ed.view.posAtDOM(el, 0) === pos,
  )
  expect(drawn).toHaveLength(boxes.length)
  drawn.forEach((el, i) => {
    const [left, right] = boxes[i] ?? [0, 0]
    el.getBoundingClientRect = () =>
      ({
        left,
        right,
        top: 0,
        bottom: 10,
        width: right - left,
        height: 10,
        x: left,
        y: 0,
      }) as DOMRect
  })
}

/** A click at `clientX` the editor resolves to `pos`: mousedown, then ProseMirror's click handlers. */
function clickAt(ed: Editor, pos: number, clientX: number, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('mousedown', { clientX, clientY: 0, bubbles: true, ...init })
  ed.view.dom.dispatchEvent(event)
  return ed.view.someProp('handleClick', (f) => f(ed.view, pos, event)) ?? false
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
    // The editor's own handling of the input still runs: Android Backspace depends on it.
    expect(
      ed.view.someProp('handleDOMEvents', (handlers) => handlers.beforeinput?.(ed.view, input)),
    ).toBeFalsy()
  })

  it('a deleteContentForward input before a marker unbolds the range and cancels the input', () => {
    const ed = createEditor(BOLD)
    // `plain **bold|** end`: the closing marker is after the caret.
    ed.commands.setTextSelection(11)
    const input = new InputEvent('beforeinput', {
      inputType: 'deleteContentForward',
      cancelable: true,
    })
    ed.view.dom.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    expect(markdown(ed)).toBe('plain bold end')
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

  it('draws no # run and leaves Backspace, the arrows and # at a heading start to the editor', () => {
    const ed = createEditor('## Title')
    ed.commands.setTextSelection(1)
    expect(markers(ed)).toEqual([])
    expect(pressKey(ed, 'Backspace')).toBe(false)
    expect(pressKey(ed, 'Delete')).toBe(false)
    expect(pressKey(ed, 'ArrowLeft')).toBe(false)
    expect(typeKey(ed, '#')).toBe(false)
  })

  it('draws no link syntax and leaves the arrows at a link’s end to the editor', () => {
    const ed = createEditor('see [label](https://a.io) end')
    ed.commands.setTextSelection(10)
    expect(markers(ed)).toEqual([])
    expect(pressKey(ed, 'ArrowRight')).toBe(false)
    expect(pressKey(ed, 'Delete')).toBe(false)
  })
})

// `## Title`: the heading's text starts at 1, so `Title` is 1..6.
const HEADING = '## Title'

describe('MarkdownReveal for headings', () => {
  beforeEach(() => {
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  it('shows each level’s # run at the start of the line while the caret is in the heading', () => {
    for (let level = 1; level <= 6; level++) {
      const ed = createEditor(`${'#'.repeat(level)} Title`)
      ed.commands.setTextSelection(4)
      expect(markers(ed)).toEqual([`${'#'.repeat(level)} `])
      expect(ed.view.dom.textContent).toBe(`${'#'.repeat(level)} Title`)
    }
  })

  it('hides the # run once the caret leaves the heading', () => {
    // `Title` is 1..6, then the paragraph `body` from 8.
    const ed = createEditor(`${HEADING}\n\nbody`)
    ed.commands.setTextSelection(3)
    expect(markers(ed)).toEqual(['## '])
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual([])
  })

  it('reveals the # run of every heading a selection crosses', () => {
    const ed = createEditor(`${HEADING}\n\n# Mid\n\n### End`)
    ed.commands.setTextSelection({ from: 3, to: ed.state.doc.content.size - 1 })
    expect(markers(ed)).toEqual(['## ', '# ', '### '])
  })

  it('Backspace after the # run lowers the heading one level, in one undo step', () => {
    const ed = createEditor(HEADING)
    type(ed, '')
    ed.commands.setTextSelection(1)
    const depth = undoDepth(ed.state)
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('# Title')
    expect(markers(ed)).toEqual(['# '])
    expect(undoDepth(ed.state)).toBe(depth + 1)
    ed.commands.undo()
    expect(markdown(ed)).toBe(HEADING)
  })

  it('lowering a heading from right of its # run keeps the caret there, where # is text', () => {
    const ed = createEditor('### Title')
    ed.commands.setTextSelection(1)
    pressKey(ed, 'Backspace')
    expect(markerBesideCaret(ed.state, 'before')?.kind).toBe('heading')
    expect(typeKey(ed, '#')).toBe(false)
    expect(ed.state.doc.textContent).toBe('#Title')
  })

  it('Backspace after the # run of a level-1 heading makes it a paragraph', () => {
    const ed = createEditor('# Title')
    ed.commands.setTextSelection(1)
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('Title')
    expect(ed.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(markers(ed)).toEqual([])
  })

  it('a deleteContentBackward input after the # run lowers the heading and cancels the input', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    const input = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      cancelable: true,
    })
    ed.view.dom.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    expect(markdown(ed)).toBe('# Title')
  })

  it('leaves Backspace inside the heading text to the editor', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(3)
    expect(pressKey(ed, 'Backspace')).toBe(false)
    expect(markdown(ed)).toBe(HEADING)
  })

  it('ArrowLeft at the heading start puts the caret left of the # run, where # raises the level', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(1)
    expect(markerBesideCaret(ed.state, 'after')?.kind).toBe('heading')
    expect(markerBesideCaret(ed.state, 'before')).toBeNull()

    expect(typeKey(ed, '#')).toBe(true)
    expect(markdown(ed)).toBe('### Title')
    // Still left of the run: a second `#` raises it again.
    typeKey(ed, '#')
    expect(markdown(ed)).toBe('#### Title')
    expect(ed.view.dom.textContent).toBe('#### Title')
  })

  it('raises a heading in one undo step', () => {
    const ed = createEditor(HEADING)
    type(ed, '')
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    const depth = undoDepth(ed.state)
    typeKey(ed, '#')
    expect(markdown(ed)).toBe('### Title')
    expect(undoDepth(ed.state)).toBe(depth + 1)
    ed.commands.undo()
    expect(markdown(ed)).toBe(HEADING)
  })

  it('a level change right after typing at the text start is an undo step of its own', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    type(ed, 'x')
    const depth = undoDepth(ed.state)
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    pressKey(ed, 'Delete')
    expect(markdown(ed)).toBe('# xTitle')
    expect(undoDepth(ed.state)).toBe(depth + 1)
    ed.commands.undo()
    expect(markdown(ed)).toBe('## xTitle')
  })

  it('undo puts the caret back left of the # run, where it was', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    typeKey(ed, '#')
    ed.commands.undo()
    expect(markdown(ed)).toBe(HEADING)
    expect(markerBesideCaret(ed.state, 'after')?.kind).toBe('heading')
    pressKey(ed, 'Delete')
    expect(markdown(ed)).toBe('# Title')
  })

  it('keeps the caret left of the # run through edits before it, and drops it where no heading starts', () => {
    // `body` is 1..5, the heading's text starts at 7.
    const ed = createEditor(`body\n\n${HEADING}`)
    ed.commands.setTextSelection(7)
    pressKey(ed, 'ArrowLeft')
    const bookmark = ed.state.selection.getBookmark()
    const insert = ed.state.tr.insertText('xx', 1)
    ed.view.dispatch(insert)
    const mapped = bookmark.map(insert.mapping)
    const outside = mapped.resolve(ed.state.doc)
    expect(isOutsideHeadingMarker(outside)).toBe(true)
    expect(outside.from).toBe(9)
    // Text typed at the heading start leaves the bookmark inside the text.
    const typed = ed.state.tr.insertText('y', 9)
    ed.view.dispatch(typed)
    const inside = mapped.map(typed.mapping).resolve(ed.state.doc)
    expect(isOutsideHeadingMarker(inside)).toBe(false)
    ed.view.dispatch(ed.state.tr.setNodeMarkup(8, ed.schema.nodes['paragraph']))
    const plain = mapped.resolve(ed.state.doc)
    expect(isOutsideHeadingMarker(plain)).toBe(false)
    expect(plain.from).toBe(9)
  })

  it('# left of a level-6 heading’s run changes nothing and types nothing', () => {
    const ed = createEditor('###### Title')
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    expect(typeKey(ed, '#')).toBe(true)
    expect(markdown(ed)).toBe('###### Title')
  })

  it('# typed right of the # run is text, as without the reveal', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    expect(typeKey(ed, '#')).toBe(false)
    expect(ed.state.doc.textContent).toBe('#Title')
  })

  it('Delete left of the # run lowers the level and keeps the caret there', () => {
    const ed = createEditor('### Title')
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('## Title')
    expect(markerBesideCaret(ed.state, 'after')?.kind).toBe('heading')
    pressKey(ed, 'Delete')
    pressKey(ed, 'Delete')
    expect(markdown(ed)).toBe('Title')
    expect(markers(ed)).toEqual([])
    // A paragraph has no # run to be left of.
    expect(isOutsideHeadingMarker(ed.state.selection)).toBe(false)
  })

  it('ArrowRight left of the # run steps back to the text start', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(markerBesideCaret(ed.state, 'before')?.kind).toBe('heading')
    expect(typeKey(ed, '#')).toBe(false)
    expect(ed.state.doc.textContent).toBe('#Title')
  })

  it('other text typed left of the # run goes to the start of the heading text', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    expect(typeKey(ed, 'X')).toBe(false)
    expect(markdown(ed)).toBe('## XTitle')
    expect(markerBesideCaret(ed.state, 'after')).toBeNull()
  })

  it('crossing the # run adds no undo step', () => {
    const ed = createEditor(HEADING)
    type(ed, 'x')
    const depth = undoDepth(ed.state)
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    pressKey(ed, 'ArrowRight')
    expect(undoDepth(ed.state)).toBe(depth)
  })

  it('steps through the # run and the markers of bold at the heading start one at a time', () => {
    const ed = createEditor('## **bold** x')
    // The block start types bold: the caret is inside both.
    ed.commands.setTextSelection(1)
    expect(ed.view.dom.textContent).toBe('## **bold** x')
    expect(markers(ed)).toEqual(['## ', '**', '**'])
    expect(ed.view.dom.querySelector('.md-reveal-marker')?.closest('strong')).toBeNull()
    pressKey(ed, 'ArrowLeft')
    expect(markerBesideCaret(ed.state, 'before')?.kind).toBe('heading')
    pressKey(ed, 'ArrowLeft')
    expect(markerBesideCaret(ed.state, 'after')?.kind).toBe('heading')
    typeKey(ed, '#')
    expect(markdown(ed)).toBe('### **bold** x')
    // Left of everything, other text is plain at the start of the heading.
    pressKey(ed, 'ArrowRight')
    type(ed, 'X')
    expect(markdown(ed)).toBe('### X**bold** x')
  })

  it('lowering a heading keeps the caret outside the bold it was outside of', () => {
    const ed = createEditor('## **bold** x')
    ed.commands.setTextSelection(1)
    pressKey(ed, 'ArrowLeft')
    pressKey(ed, 'Backspace')
    expect(markdown(ed)).toBe('# **bold** x')
    type(ed, 'X')
    expect(markdown(ed)).toBe('# X**bold** x')
  })

  it('Backspace in an empty heading lowers it, then leaves an empty paragraph', () => {
    const ed = createEditor('## ')
    ed.commands.setTextSelection(1)
    expect(ed.view.dom.textContent).toBe('## ')
    pressKey(ed, 'Backspace')
    expect(ed.state.doc.firstChild?.attrs['level']).toBe(1)
    pressKey(ed, 'Backspace')
    expect(ed.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(pressKey(ed, 'Backspace')).toBe(false)
  })

  it('hides the # run from screen readers and in-page find', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(3)
    const marker = ed.view.dom.querySelector('[data-testid="md-reveal-marker"]')
    expect(marker?.getAttribute('aria-hidden')).toBe('true')
    expect(marker?.hasAttribute('data-find-skip')).toBe(true)
    expect(marker?.closest('h2')).not.toBeNull()
  })

  it('never puts the # run into the document or the stored Markdown', () => {
    const ed = createEditor(HEADING)
    ed.commands.setTextSelection(3)
    expect(markers(ed)).toEqual(['## '])
    expect(ed.state.doc.textContent).toBe('Title')
    expect(markdown(ed)).toBe(HEADING)
  })

  it('a click left of the # run puts the caret there, and right of it at the text start', () => {
    const ed = createEditor('## **bold** x')
    ed.commands.setTextSelection(3)
    // jsdom lays nothing out: every marker's box is at x 0, and the click lands at the heading start.
    ed.view.posAtCoords = () => ({ pos: 1, inside: -1 })
    clickAt(ed, 1, -1)
    expect(markerBesideCaret(ed.state, 'after')?.kind).toBe('heading')
    typeKey(ed, '#')
    expect(markdown(ed)).toBe('### **bold** x')

    ed.commands.setTextSelection(3)
    clickAt(ed, 1, 1)
    expect(markerBesideCaret(ed.state, 'before')?.text).toBe('**')
  })

  it('a click where no marker is drawn is left to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(9)
    ed.view.posAtCoords = () => ({ pos: 9, inside: -1 })
    expect(clickAt(ed, 9, 1)).toBe(false)
  })

  it('a click at markers a composition froze is left to the editor', () => {
    const ed = createEditor(BOLD)
    ed.commands.setTextSelection(14)
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    // The state now reveals the bold's markers; the frozen view draws none.
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual([])
    ed.view.posAtCoords = () => ({ pos: 11, inside: -1 })
    expect(clickAt(ed, 11, 1)).toBe(false)
  })

  it('a click between the # run and an opening bold marker puts the caret between them', () => {
    const ed = createEditor('## **bold** x')
    ed.commands.setTextSelection(3)
    ed.view.posAtCoords = () => ({ pos: 1, inside: -1 })
    // Drawn `## ` over 0..20 and `**` over 20..30: a click at 22 is right of the run, left of the `**`.
    layOut(ed, 1, [
      [0, 20],
      [20, 30],
    ])
    expect(clickAt(ed, 1, 22)).toBe(true)
    type(ed, 'X')
    expect(markdown(ed)).toBe('## X**bold** x')
  })

  it('a click between two closing markers puts the caret between them, in the order drawn', () => {
    const ed = createEditor('***both*** x')
    ed.commands.setTextSelection(3)
    ed.view.posAtCoords = () => ({ pos: 5, inside: -1 })
    // Drawn `*` over 0..10 and `**` over 10..30: a click at 15 is past italic's close, before bold's.
    layOut(ed, 5, [
      [0, 10],
      [10, 30],
    ])
    expect(clickAt(ed, 5, 15)).toBe(true)
    type(ed, 'X')
    expect(markdown(ed)).toBe('***both*X** x')
  })

  it('a click at a closing bold marker in a heading leaves the # run where it is', () => {
    // `## **a** x`: `a` is 1..2, so its markers sit at 1 and 2 and the `#` run at 1.
    const ed = createEditor('## **a** x')
    ed.commands.setTextSelection(2)
    ed.view.posAtCoords = () => ({ pos: 2, inside: -1 })
    layOut(ed, 2, [[0, 10]])
    expect(clickAt(ed, 2, 20)).toBe(true)
    expect(isOutsideHeadingMarker(ed.state.selection)).toBe(false)
    expect(markerBesideCaret(ed.state, 'before')?.text).toBe('**')
    expect(markerBesideCaret(ed.state, 'after')).toBeNull()
  })

  it('a Ctrl+Click at a marker is left to the link it may open', () => {
    const ed = createEditor('see [label](https://a.io) end')
    ed.commands.setTextSelection(7)
    ed.view.posAtCoords = () => ({ pos: 10, inside: -1 })
    expect(clickAt(ed, 10, 1, { ctrlKey: true })).toBe(false)
    expect(clickAt(ed, 10, 1)).toBe(true)
  })

  it('keeps the # run in place while an IME composes, and redraws once it ends', () => {
    vi.useFakeTimers()
    const ed = createEditor(`${HEADING}\n\nbody`)
    ed.commands.setTextSelection(3)
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    expect(ed.view.composing).toBe(true)
    // The caret leaves the heading while the composition is open.
    ed.commands.setTextSelection(9)
    expect(markers(ed)).toEqual(['## '])
    ed.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }))
    vi.runAllTimers()
    expect(markers(ed)).toEqual([])
  })
})

// `see [label](https://a.io) end`: `label` is 5..10, ` end` 10..14.
const LINK = 'see [label](https://a.io) end'

describe('MarkdownReveal for external links', () => {
  beforeEach(() => {
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  it('shows [ and ](url) around the label while the caret is in it', () => {
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(7)
    expect(markers(ed)).toEqual(['[', '](https://a.io)'])
    expect(ed.view.dom.textContent).toBe(LINK)
    ed.commands.setTextSelection(12)
    expect(markers(ed)).toEqual([])
  })

  it('reveals nothing around a bare URL, which the serializer writes as it is', () => {
    const ed = createEditor('go https://a.io now')
    ed.commands.setTextSelection(8)
    expect(ed.state.doc.nodeAt(7)?.marks.map((m) => m.type.name)).toEqual(['link'])
    expect(markers(ed)).toEqual([])
    expect(pressKey(ed, 'Backspace')).toBe(false)
  })

  it('reveals a link whose text is its URL when the text carries emphasis', () => {
    const ed = createEditor('go [**https://a.io**](https://a.io)')
    ed.commands.setTextSelection(8)
    expect(markers(ed)).toEqual(['[', '**', '**', '](https://a.io)'])
  })

  it('reveals a link whose text is its URL when the URL is not one the parser autolinks', () => {
    const ed = createEditor('go [a.io](a.io)')
    ed.commands.setTextSelection(5)
    expect(markers(ed)).toEqual(['[', '](a.io)'])
  })

  it('Delete before [ unlinks the label, in one undo step', () => {
    const ed = createEditor(LINK)
    type(ed, '')
    // `see |[label`: typing at the label start does not link, so the caret is outside.
    ed.commands.setTextSelection(5)
    const depth = undoDepth(ed.state)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('see label end')
    expect(undoDepth(ed.state)).toBe(depth + 1)
    ed.commands.undo()
    expect(markdown(ed)).toBe(LINK)
  })

  it('Backspace after [ unlinks the label', () => {
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(5)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('see label end')
  })

  it('Delete before ](url) unlinks the label', () => {
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(10)
    expect(pressKey(ed, 'Delete')).toBe(true)
    expect(markdown(ed)).toBe('see label end')
  })

  it('Backspace after ](url) unlinks the label', () => {
    const ed = createEditor(LINK)
    // `see [label](url) |end`, then ArrowLeft onto the link's end from outside it.
    ed.commands.setTextSelection(11)
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(10)
    expect(pressKey(ed, 'Backspace')).toBe(true)
    expect(markdown(ed)).toBe('see label end')
  })

  it('unlinks every character of a label that changes formatting inside', () => {
    const ed = createEditor('see [a **b** c](https://a.io) end')
    ed.commands.setTextSelection(5)
    pressKey(ed, 'Delete')
    expect(markdown(ed)).toBe('see a **b** c end')
  })

  it('draws the link’s own brackets outside the link and the bold markers inside it', () => {
    const ed = createEditor('see [**b**](https://a.io) end')
    ed.commands.setTextSelection(6)
    expect(markers(ed)).toEqual(['[', '**', '**', '](https://a.io)'])
    const drawn = [...ed.view.dom.querySelectorAll('.md-reveal-marker')]
    expect(drawn.map((el) => el.closest('a') !== null)).toEqual([false, true, true, false])
  })

  it('crosses the closing bold marker, then ](url), one at a time', () => {
    const ed = createEditor('see [**b**](https://a.io) end')
    // `see [**b|**](url)`: inside both.
    ed.commands.setTextSelection(6)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(markerBesideCaret(ed.state, 'after')?.text).toBe('](https://a.io)')
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(markerBesideCaret(ed.state, 'before')?.text).toBe('](https://a.io)')
    expect(ed.state.selection.from).toBe(6)
    type(ed, 'X')
    expect(markdown(ed)).toBe('see [**b**](https://a.io)X end')
  })

  it('ArrowRight at the end of the label steps past ](url), so typing there is not linked', () => {
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(10)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(ed.state.selection.from).toBe(10)
    expect(ed.view.dom.textContent).toBe(LINK)
    type(ed, 'X')
    expect(markdown(ed)).toBe('see [label](https://a.io)X end')
  })

  it('ArrowRight at the end of a label that ends the block steps past ](url), typing no space', () => {
    // The link's own ArrowRight would leave it there by typing a space (TipTap's `exitable`).
    const ed = createEditor('see [label](https://a.io)')
    ed.commands.setTextSelection(10)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    expect(markdown(ed)).toBe('see [label](https://a.io)')
    type(ed, 'X')
    expect(markdown(ed)).toBe('see [label](https://a.io)X')
  })

  it('ArrowLeft past ](url) steps back inside the link', () => {
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(11)
    pressKey(ed, 'ArrowLeft')
    expect(pressKey(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(10)
    type(ed, 'X')
    expect(markdown(ed)).toBe('see [labelX](https://a.io) end')
  })

  it('past ](url), typing keeps the emphasis that runs on beyond the link', () => {
    // `a` is bold and linked, ` b` bold: the bold runs on past the link's end at 2.
    const ed = createEditor('**[a](https://a.io) b**')
    ed.commands.setTextSelection(2)
    expect(pressKey(ed, 'ArrowRight')).toBe(true)
    type(ed, 'X')
    expect(ed.state.doc.nodeAt(2)?.text).toBe('X b')
    expect(ed.state.doc.nodeAt(2)?.marks.map((m) => m.type.name)).toEqual(['bold'])
  })

  it('keeps the link markers in place while an IME composes in the text', () => {
    vi.useFakeTimers()
    const ed = createEditor(LINK)
    ed.commands.setTextSelection(7)
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    ed.commands.setTextSelection(12)
    expect(markers(ed)).toEqual(['[', '](https://a.io)'])
    ed.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }))
    vi.runAllTimers()
    expect(markers(ed)).toEqual([])
  })

  it('shows a heading’s # run and its link’s syntax together', () => {
    const ed = createEditor('## see [x](https://a.io)')
    ed.commands.setTextSelection(6)
    expect(markers(ed)).toEqual(['## ', '[', '](https://a.io)'])
  })
})

describe('MarkdownReveal beside a list marker', () => {
  beforeEach(() => {
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  /** Every revealed marker drawn, in document order, as the user reads them after the list marker. */
  function followsListMarker(ed: Editor): boolean[] {
    const listMarker = ed.view.dom.querySelector('.list-marker')
    if (!listMarker) throw new Error('no list marker is drawn')
    return [...ed.view.dom.querySelectorAll('.md-reveal-marker')].map(
      (el) => (listMarker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    )
  }

  it('draws the syntax revealed at a block’s start after its list marker, whichever side of the caret', () => {
    for (const [source, caret, drawn] of [
      ['## Title', 3, 1],
      ['**bold** rest', 3, 2],
      ['[label](https://a.io) rest', 3, 2],
    ] as const) {
      const ed = createEditor(source, [ListMarkerDecoration])
      ed.view.dispatch(setListMarkerMeta(ed.state.tr, { style: 'ordered', ordinal: 1 }))
      ed.commands.setTextSelection(caret)
      expect(followsListMarker(ed)).toEqual(Array(drawn).fill(true))
    }
    // Left of the # run, the run is drawn past the caret: still after the list marker.
    const heading = createEditor(HEADING, [ListMarkerDecoration])
    heading.view.dispatch(setListMarkerMeta(heading.state.tr, { style: 'ordered', ordinal: 1 }))
    heading.commands.setTextSelection(1)
    pressKey(heading, 'ArrowLeft')
    expect(followsListMarker(heading)).toEqual([true])
  })
})

describe('MarkdownReveal beside page, tag and block-ref chips (#5974)', () => {
  beforeEach(() => {
    writePreference(PREFERENCES.revealMarkdownSyntax, true)
  })

  const TAG = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const PAGE = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
  const SOURCE = `a #[${TAG}] [[${PAGE}]] ((${PAGE})) b`

  function chipEditor(source = SOURCE): Editor {
    // `a ` 1..3, the tag chip 3..4, ` ` 4..5, the page chip 5..6, ` ` 6..7, the block ref 7..8, ` b` 8..10.
    const ed = createEditor(source, [
      TagRef.configure({ resolveName: () => 'work' }),
      BlockLink.configure({ resolveTitle: () => 'Plan' }),
      BlockRef.configure({ resolveContent: () => 'A block' }),
    ])
    return ed
  }

  /** The editor's text as the user reads it, the chip syntax drawn included. */
  const shown = (ed: Editor): string => ed.view.dom.textContent ?? ''

  it('parses the layout the positions below assume', () => {
    const ed = chipEditor()
    expect(ed.state.doc.nodeAt(3)?.type.name).toBe('tag_ref')
    expect(ed.state.doc.nodeAt(5)?.type.name).toBe('block_link')
    expect(ed.state.doc.nodeAt(7)?.type.name).toBe('block_ref')
  })

  it.each([
    [1, 'a work Plan A block b'],
    [2, 'a work Plan A block b'],
    // Beside a chip, both of its sides are drawn, whichever side the caret is on.
    [3, 'a #work Plan A block b'],
    [4, 'a #work Plan A block b'],
    [5, 'a work [[Plan]] A block b'],
    [6, 'a work [[Plan]] A block b'],
    [7, 'a work Plan ((A block)) b'],
    [8, 'a work Plan ((A block)) b'],
    [9, 'a work Plan A block b'],
  ])('a caret at %i shows %j', (pos, expected) => {
    const ed = chipEditor()
    ed.commands.setTextSelection(pos)
    expect(shown(ed)).toBe(expected)
  })

  it('shows the syntax of a selected chip, and only the `#` of a tag', () => {
    const ed = chipEditor()
    ed.commands.setNodeSelection(3)
    expect(shown(ed)).toBe('a #work Plan A block b')
    ed.commands.setNodeSelection(5)
    expect(shown(ed)).toBe('a work [[Plan]] A block b')
    ed.commands.setNodeSelection(7)
    expect(shown(ed)).toBe('a work Plan ((A block)) b')
  })

  it('shows the syntax of both chips a caret sits between', () => {
    const ed = chipEditor(`#[${TAG}][[${PAGE}]]`)
    ed.commands.setTextSelection(2)
    expect(shown(ed)).toBe('#work[[Plan]]')
    ed.commands.setTextSelection(1)
    expect(shown(ed)).toBe('#workPlan')
  })

  it('draws nothing with the setting off, away from a chip, or for a range', () => {
    const ed = chipEditor()
    ed.commands.setTextSelection({ from: 3, to: 9 })
    expect(shown(ed)).toBe('a work Plan A block b')
    ed.commands.setNodeSelection(5)
    expect(shown(ed)).toBe('a work [[Plan]] A block b')
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    ed.view.dispatch(ed.state.tr)
    expect(shown(ed)).toBe('a work Plan A block b')
  })

  it('draws it aria-hidden, out of find and out of the document', () => {
    const ed = chipEditor()
    ed.commands.setNodeSelection(5)
    const drawn = [...ed.view.dom.querySelectorAll('.md-reveal-chip-marker')]
    expect(drawn.map((el) => el.textContent)).toEqual(['[[', ']]'])
    expect(drawn.map((el) => el.getAttribute('aria-hidden'))).toEqual(['true', 'true'])
    expect(drawn.map((el) => el.hasAttribute('data-find-skip'))).toEqual([true, true])
    expect(markdown(ed)).toBe(SOURCE)
    expect(markers(ed)).toEqual([])
  })

  it('leaves the arrows, Backspace and Delete at a chip as they are with the setting off', () => {
    const outcome = (on: boolean, pos: number, key: string) => {
      writePreference(PREFERENCES.revealMarkdownSyntax, on)
      const ed = chipEditor()
      ed.commands.setTextSelection(pos)
      const handled = pressKey(ed, key)
      const { from, to } = ed.state.selection
      return { handled, from, to, md: markdown(ed) }
    }
    for (const pos of [3, 4, 5, 6, 7, 8]) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']) {
        expect(outcome(true, pos, key)).toEqual(outcome(false, pos, key))
      }
    }
    // Backspace right of the page chip takes the chip whole.
    expect(outcome(true, 6, 'Backspace').md).toBe(`a #[${TAG}]  ((${PAGE})) b`)
  })

  it('does not change the document, the selection or the history when the syntax is drawn', () => {
    const ed = chipEditor()
    const doc = ed.state.doc
    ed.commands.setTextSelection(6)
    expect(ed.state.selection.from).toBe(6)
    expect(ed.state.selection.empty).toBe(true)
    expect(ed.state.doc.eq(doc)).toBe(true)
    expect(undoDepth(ed.state)).toBe(0)
  })

  it('draws a chip’s syntax after the closing delimiter of the bold it follows', () => {
    const ed = createEditor(`**b**[[${PAGE}]]`, [
      BlockLink.configure({ resolveTitle: () => 'Plan' }),
    ])
    ed.commands.setTextSelection(2)
    expect(shown(ed)).toBe('**b**[[Plan]]')
  })

  it('draws a chip’s closing syntax before the opening delimiter of the bold it precedes', () => {
    const ed = createEditor(`[[${PAGE}]]**b**`, [
      BlockLink.configure({ resolveTitle: () => 'Plan' }),
    ])
    ed.commands.setTextSelection(2)
    expect(shown(ed)).toBe('[[Plan]]**b**')
  })
})
