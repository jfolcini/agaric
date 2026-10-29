/**
 * #5974 — "Show Markdown syntax around the cursor" in page mode's one document
 * of `pageBlock` nodes: the markers of the mark, heading or link the caret is
 * in, drawn as in block mode (`markdown-reveal.test.ts`), and what the page
 * adds. Backspace after a marker at a block's start removes the mark instead
 * of joining the block or taking its list style off, a marker deleted is one
 * step of the page-wide history, arrows cross a marker and then the block's
 * end, a selection across blocks reveals nothing, and the markers drawn are
 * the caret's own however many blocks the page holds.
 */

import { Editor } from '@tiptap/core'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  blockId,
  caret,
  idMinter,
  idsOf,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
  type as typeText,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { listSource } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { toggleFold } from '@/editor/page-mode/page-collapse'
import { PageLists } from '@/editor/page-mode/page-lists'
import type { PropertyRow } from '@/lib/bindings'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)

const open: Editor[] = []

beforeEach(() => {
  localStorage.clear()
  writePreference(PREFERENCES.revealMarkdownSyntax, true)
})

afterEach(() => {
  for (const ed of open.splice(0)) {
    ed.view.dom.remove()
    ed.destroy()
  }
  vi.useRealTimers()
})

function page(rows: readonly Row[], lists?: PageLists): Editor {
  const ed = openPage(
    rows,
    idMinter(),
    undefined,
    lists === undefined ? undefined : listSource(lists),
  )
  open.push(ed)
  // Nothing is drawn while the editor is unfocused.
  document.body.append(ed.view.dom)
  ed.view.focus()
  return ed
}

/** The revealed markers, in document order, as the user reads them. */
function markers(ed: Editor): string[] {
  return [...ed.view.dom.querySelectorAll('.md-reveal-marker')].map((el) => el.textContent ?? '')
}

const bullet: PropertyRow[] = [
  {
    key: 'listStyle',
    value_text: 'bullet',
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  },
]

// Block 1 `plain **bold** end`: its text starts at offset 0, `bold` is 6..10.
const BOLD: Row = [B, 0, 'plain **bold** end']

describe('MarkdownReveal in page mode', () => {
  it('draws the markers of bold, a heading and a link around the caret, and none elsewhere', () => {
    const ed = page([[A, 0, 'first'], BOLD, [C, 0, '## Title [label](https://example.com) x']])
    caret(ed, 0, 2)
    expect(markers(ed)).toEqual([])
    caret(ed, 1, 8)
    expect(markers(ed)).toEqual(['**', '**'])
    caret(ed, 2, 2)
    expect(markers(ed)).toEqual(['## '])
    caret(ed, 2, 9)
    expect(markers(ed)).toEqual(['## ', '[', '](https://example.com)'])
  })

  it('draws nothing with the setting off, and reveals nothing around a bare URL', () => {
    const ed = page([[A, 0, 'go https://example.com now'], BOLD])
    caret(ed, 0, 8)
    expect(markers(ed)).toEqual([])
    caret(ed, 1, 8)
    expect(markers(ed)).toEqual(['**', '**'])
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    ed.view.dispatch(ed.state.tr)
    expect(markers(ed)).toEqual([])
  })

  it('draws only the caret’s own markers on a page where every block is formatted', () => {
    const rows = Array.from({ length: 60 }, (_, i): Row => [
      blockId(i + 1),
      0,
      `a **b${i}** c *d* e`,
    ])
    const ed = page(rows)
    caret(ed, 30, 4)
    expect(markers(ed)).toEqual(['**', '**'])
  })

  it('reveals nothing for a selection across blocks, Ctrl+A included, and again once it is one block’s', () => {
    const ed = page([[A, 0, '## **one** two'], BOLD, [C, 0, '**three**']])
    caret(ed, 1, 8)
    expect(markers(ed)).toEqual(['**', '**'])
    ed.view.dispatch(
      ed.state.tr.setSelection(
        TextSelection.create(ed.state.doc, posIn(ed, 0, 3), posIn(ed, 2, 3)),
      ),
    )
    expect(markers(ed)).toEqual([])
    ed.view.dispatch(ed.state.tr.setSelection(new AllSelection(ed.state.doc)))
    expect(markers(ed)).toEqual([])
    ed.view.dispatch(
      ed.state.tr.setSelection(
        TextSelection.create(ed.state.doc, posIn(ed, 1, 7), posIn(ed, 1, 9)),
      ),
    )
    expect(markers(ed)).toEqual(['**', '**'])
  })

  it('Ctrl+A on a page of one block reveals that block’s markers', () => {
    const ed = page([BOLD])
    ed.view.dispatch(ed.state.tr.setSelection(new AllSelection(ed.state.doc)))
    expect(markers(ed)).toEqual(['**', '**'])
  })

  it('Backspace after the opening marker at a block’s start unbolds it, without joining the block above', () => {
    const ed = page([
      [A, 0, 'first'],
      [B, 0, '**bold** end'],
    ])
    caret(ed, 1, 0)
    expect(markers(ed)).toEqual(['**', '**'])
    // The caret is inside the bold at the block's start, right of the opening marker.
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'first'],
      [B, 0, 'bold end'],
    ])
    ed.commands.undo()
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'first'],
      [B, 0, '**bold** end'],
    ])
  })

  it('Backspace after a # run at a block’s start lowers the heading, and a level 1 becomes a paragraph', () => {
    const ed = page([
      [A, 0, 'first'],
      [B, 0, '## Title'],
    ])
    caret(ed, 1, 0)
    expect(markers(ed)).toEqual(['## '])
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)[1]).toEqual([B, 0, '# Title'])
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'first'],
      [B, 0, 'Title'],
    ])
    // No marker is left beside the caret: Backspace is the join's again.
    expect(markers(ed)).toEqual([])
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'firstTitle']])
  })

  it('Backspace after a marker in a list block unmarks the text and keeps the block’s list style', () => {
    const lists = new PageLists(
      { [B]: bullet },
      [
        { id: A, depth: 0 },
        { id: B, depth: 0 },
      ],
      () => false,
    )
    const ed = page(
      [
        [A, 0, 'first'],
        [B, 0, '**bold** end'],
      ],
      lists,
    )
    caret(ed, 1, 0)
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)[1]).toEqual([B, 0, 'bold end'])
    expect(lists.styleOf(B)).toBe('bullet')
    // With no marker beside it, the same key takes the style off.
    expect(press(ed, 'Backspace')).toBe(true)
    expect(lists.styleOf(B)).toBe('none')
  })

  it('Delete before a closing marker at a block’s end unbolds it, without joining the next block', () => {
    const ed = page([
      [A, 0, 'first **bold**'],
      [B, 0, 'next'],
    ])
    caret(ed, 0, 10)
    expect(markers(ed)).toEqual(['**', '**'])
    expect(press(ed, 'Delete')).toBe(true)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'first bold'],
      [B, 0, 'next'],
    ])
  })

  it('a marker deleted is one step of the page’s history, and undo leaves the text typed before it', () => {
    const ed = page([[A, 0, 'first'], BOLD, [C, 0, 'last']])
    caret(ed, 0, 5)
    typeText(ed, '!')
    // `plain |bold`, then ArrowRight: right of the opening marker, where typing is bold.
    caret(ed, 1, 6)
    expect(press(ed, 'ArrowRight')).toBe(true)
    expect(press(ed, 'Backspace')).toBe(true)
    expect(rowsOf(ed.state.doc)[1]).toEqual([B, 0, 'plain bold end'])
    ed.commands.undo()
    expect(rowsOf(ed.state.doc).map((r) => r[2])).toEqual(['first!', 'plain **bold** end', 'last'])
  })

  it('ArrowRight at a block’s end steps out of the mark first, and the next one is the editor’s, leaving the block', () => {
    const ed = page([
      [A, 0, 'first **bold**'],
      [B, 0, 'next'],
    ])
    caret(ed, 0, 10)
    expect(press(ed, 'ArrowRight')).toBe(true)
    // Past the closing marker: the position is the same, typing is not bold.
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 10))
    typeText(ed, 'x')
    expect(rowsOf(ed.state.doc)[0]).toEqual([A, 0, 'first **bold**x'])
    caret(ed, 0, 11)
    expect(press(ed, 'ArrowRight')).toBe(false)
  })

  it('ArrowLeft at a block’s start, with a marker there, steps over it before it leaves the block', () => {
    const ed = page([
      [A, 0, 'first'],
      [B, 0, '**bold** end'],
    ])
    caret(ed, 1, 0)
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(posIn(ed, 1, 0))
    expect(press(ed, 'ArrowLeft')).toBe(false)
  })

  it('an arrow into the next block lands outside the formatting at the edge it enters, either way', () => {
    const ed = page([
      [A, 0, 'first **bold**'],
      [B, 0, '**bold** end'],
    ])
    // happy-dom lays nothing out: the caret is at its line's edge.
    ed.view.endOfTextblock = () => true
    // `**|bold** end`: over the opening marker, then into the block above, past its closing one.
    caret(ed, 1, 0)
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(ed.state.selection.from).toBe(posIn(ed, 0, 10))
    typeText(ed, 'y')
    expect(rowsOf(ed.state.doc)[0]).toEqual([A, 0, 'first **bold**y'])
    // `first boldy|`: into the block below, left of its opening marker.
    expect(press(ed, 'ArrowRight')).toBe(true)
    expect(ed.state.selection.from).toBe(posIn(ed, 1, 0))
    typeText(ed, 'x')
    expect(rowsOf(ed.state.doc)[1]).toEqual([B, 0, 'x**bold** end'])
  })

  // The caret's block is never hidden: an arrow that landed in a hidden block would open it.
  it('ArrowRight at the end of a collapsed block leaves the blocks it hides to the editor', () => {
    const ed = page([
      [A, 0, 'parent'],
      [B, 1, '**bold** x'],
      [C, 0, 'next'],
    ])
    ed.view.endOfTextblock = () => true
    expect(toggleFold(A)(ed.state, ed.view.dispatch)).toBe(true)
    caret(ed, 0, 6)
    expect(press(ed, 'ArrowRight')).toBe(false)
    expect(ed.state.selection.$head.index(0)).toBe(0)
  })

  it('ArrowLeft at the start of the block after a collapsed block leaves the blocks it hides to the editor', () => {
    const ed = page([
      [A, 0, 'parent'],
      [B, 1, 'x **bold**'],
      [C, 0, 'next'],
    ])
    ed.view.endOfTextblock = () => true
    expect(toggleFold(A)(ed.state, ed.view.dispatch)).toBe(true)
    caret(ed, 2, 0)
    expect(press(ed, 'ArrowLeft')).toBe(false)
    expect(ed.state.selection.$head.index(0)).toBe(2)
  })

  it('leaves an arrow into the next block to the editor with the setting off', () => {
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    const ed = page([
      [A, 0, 'first **bold**'],
      [B, 0, '**bold** end'],
    ])
    ed.view.endOfTextblock = () => true
    caret(ed, 0, 10)
    expect(press(ed, 'ArrowRight')).toBe(false)
    caret(ed, 1, 0)
    expect(press(ed, 'ArrowLeft')).toBe(false)
  })

  it('the arrows step over a link’s bracket and a # run one at a time', () => {
    const ed = page([
      [A, 0, 'first'],
      [B, 0, '## [label](https://e.com) x'],
    ])
    caret(ed, 1, 0)
    expect(markers(ed)).toEqual(['## ', '[', '](https://e.com)'])
    // Left over `[`, then over the `#` run, and back.
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(press(ed, 'ArrowLeft')).toBe(true)
    expect(press(ed, 'ArrowRight')).toBe(true)
    expect(press(ed, 'ArrowRight')).toBe(true)
    // Back inside the label at its start, with no marker ahead: the editor moves on.
    expect(press(ed, 'ArrowRight')).toBe(false)
  })

  it('draws no marker beside a chip, and leaves the arrows to the editor', () => {
    const ed = page([[A, 0, 'a #[01ARZ3NDEKTSV4RRFFQ69G5FAV] b']])
    expect(ed.state.doc.nodeAt(posIn(ed, 0, 2))?.type.name).toBe('tag_ref')
    for (const offset of [2, 3]) {
      caret(ed, 0, offset)
      expect(markers(ed)).toEqual([])
      expect(press(ed, 'ArrowRight')).toBe(false)
      expect(press(ed, 'ArrowLeft')).toBe(false)
    }
  })

  it('keeps the markers in place while an IME composes, and redraws them once it ends', () => {
    vi.useFakeTimers()
    const ed = page([[A, 0, 'first'], BOLD])
    caret(ed, 1, 8)
    ed.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    caret(ed, 0, 2)
    expect(markers(ed)).toEqual(['**', '**'])
    ed.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }))
    vi.runAllTimers()
    expect(markers(ed)).toEqual([])
  })

  it('leaves the block ids and the other blocks as they were through a marker’s deletion', () => {
    const ed = page([
      [A, 0, 'first'],
      [B, 1, '**bold**'],
      [C, 0, 'last'],
    ])
    caret(ed, 1, 2)
    expect(press(ed, 'Backspace')).toBe(false)
    caret(ed, 1, 0)
    expect(press(ed, 'Backspace')).toBe(true)
    expect(idsOf(ed.state.doc)).toEqual([A, B, C])
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'first'],
      [B, 1, 'bold'],
      [C, 0, 'last'],
    ])
  })
})

describe('MarkdownReveal beside chips in page mode', () => {
  const TAG = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const LINK = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

  /** The chips' syntax, in document order. */
  function chipSyntax(ed: Editor): string[] {
    return [...ed.view.dom.querySelectorAll('.md-reveal-chip-marker')].map(
      (el) => el.textContent ?? '',
    )
  }

  // Block 1: `x ` 0..2, the tag chip 2..3, ` ` 3..4, the page chip 4..5, ` ` 5..6, the block ref 6..7.
  const CHIPS: Row = [B, 0, `x #[${TAG}] [[${LINK}]] ((${LINK}))`]

  it.each([
    [0, []],
    [2, ['#']],
    [3, ['#']],
    [4, ['[[', ']]']],
    [5, ['[[', ']]']],
    [6, ['((', '))']],
    [7, ['((', '))']],
  ])('a caret at offset %i of a block draws %j', (offset, expected) => {
    const ed = page([[A, 0, 'first'], CHIPS, [C, 0, 'last']])
    caret(ed, 1, offset)
    expect(chipSyntax(ed)).toEqual(expected)
    expect(markers(ed)).toEqual([])
  })

  it('draws a selected chip’s syntax, and nothing with the setting off or across blocks', () => {
    const ed = page([[A, 0, 'first'], CHIPS, [C, 0, 'last']])
    ed.commands.setNodeSelection(posIn(ed, 1, 4))
    expect(chipSyntax(ed)).toEqual(['[[', ']]'])
    ed.view.dispatch(
      ed.state.tr.setSelection(
        TextSelection.create(ed.state.doc, posIn(ed, 0, 2), posIn(ed, 1, 5)),
      ),
    )
    expect(chipSyntax(ed)).toEqual([])
    caret(ed, 1, 4)
    writePreference(PREFERENCES.revealMarkdownSyntax, false)
    ed.view.dispatch(ed.state.tr)
    expect(chipSyntax(ed)).toEqual([])
  })

  it('draws only the caret’s chips on a page where every block holds chips', () => {
    const rows = Array.from({ length: 60 }, (_, i): Row => [
      blockId(i + 1),
      0,
      `a [[${LINK}]] b #[${TAG}]`,
    ])
    const ed = page(rows)
    caret(ed, 30, 2)
    expect(chipSyntax(ed)).toEqual(['[[', ']]'])
  })

  it('leaves Backspace and Delete at a chip as the setting off has them, a block’s start joining it', () => {
    const outcome = (on: boolean, index: number, offset: number, key: string) => {
      writePreference(PREFERENCES.revealMarkdownSyntax, on)
      const ed = page([
        [A, 0, 'first'],
        [B, 0, `[[${LINK}]] x #[${TAG}]`],
      ])
      caret(ed, index, offset)
      const handled = press(ed, key)
      const out = { handled, rows: rowsOf(ed.state.doc), from: ed.state.selection.from }
      ed.destroy()
      open.pop()
      return out
    }
    for (const offset of [0, 1, 3, 4, 5])
      for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'])
        expect(outcome(true, 1, offset, key)).toEqual(outcome(false, 1, offset, key))
  })
})

describe('MarkdownReveal for quotes and code blocks in page mode (#5691)', () => {
  /** The construct syntax drawn, in document order, as the user reads it: widgets, and a block's lines above and below it. */
  function syntax(ed: Editor): string[] {
    return [
      ...ed.view.dom.querySelectorAll('.md-reveal-syntax-marker, .md-reveal-block-syntax'),
    ].flatMap((el) =>
      el.classList.contains('md-reveal-block-syntax')
        ? [el.getAttribute('data-reveal-open') ?? '', el.getAttribute('data-reveal-close') ?? '']
        : [el.textContent ?? ''],
    )
  }

  const ROWS: Row[] = [
    [A, 0, '> [!TIP] note'],
    [B, 0, '```js\nx = 1\n```'],
    [C, 0, 'plain'],
  ]

  it('draws the caret’s callout line and code fences, nothing elsewhere or across blocks, and saves none of it', () => {
    const ed = page(ROWS)
    // A quote's text is one level deeper than a paragraph's: `posIn` is the quote's start, +1 its line's.
    const inNote = posIn(ed, 0, 1) + 1
    ed.commands.setTextSelection(inNote)
    expect(syntax(ed)).toEqual(['> [!TIP] '])
    expect(ed.state.selection.from).toBe(inNote)
    caret(ed, 1, 2)
    expect(syntax(ed)).toEqual(['```js', '```'])
    caret(ed, 2, 2)
    expect(syntax(ed)).toEqual([])
    ed.view.dispatch(
      ed.state.tr.setSelection(TextSelection.create(ed.state.doc, inNote, posIn(ed, 1, 2))),
    )
    expect(syntax(ed)).toEqual([])
    expect(rowsOf(ed.state.doc)).toEqual(ROWS)
  })
})
