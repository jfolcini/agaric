/**
 * #5689 — the revealed syntax never changes what is saved. One editor reveals
 * Markdown syntax, the other is the plain WYSIWYG editor. Random headings and
 * paragraphs of nested and adjacent marks, links and bare URLs get the same
 * random caret moves, selections and typing in both. Each edit only the
 * revealing editor can make is matched in the other by TipTap's own command
 * for it:
 * - deleting a mark's marker by removing that mark from its range
 *   (`extendMarkRange` + `unsetMark`);
 * - deleting or adding to a heading's `#` run by `setNode` / `setParagraph`.
 * Crossing a marker changes only the caret, which the other editor copies.
 * After every edit both save the same Markdown and hold the same undo history.
 */

import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import Heading from '@tiptap/extension-heading'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { closeHistory, undoDepth } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExternalLink } from '@/editor/extensions/external-link'
import { MarkdownReveal } from '@/editor/extensions/markdown-reveal'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { serialize } from '@/editor/markdown-serializer'
import { isOutsideHeadingMarker, markerBesideCaret } from '@/editor/revealed-markers'
import type { DocNode } from '@/editor/types'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const NUM_RUNS = Number(process.env['SWEEP_RUNS'] ?? 200)

const HREFS = ['https://a.io', 'https://b.io'] as const

const editors: Array<{ editor: Editor; host: HTMLElement }> = []

beforeEach(() => {
  localStorage.clear()
  writePreference(PREFERENCES.revealMarkdownSyntax, true)
})

afterEach(() => {
  destroyEditors()
})

function destroyEditors(): void {
  for (const { editor, host } of editors.splice(0)) {
    editor.destroy()
    host.remove()
  }
}

interface Segment {
  text: string
  marks: readonly string[]
  href: string | null
}

const arbText = fc
  .array(fc.constantFrom('a', 'b', ' '), { minLength: 1, maxLength: 4 })
  .map((cs) => cs.join(''))

// Code excludes every other mark, the link too, so a segment is code alone or
// any emphasis subset, linked or not; a bare URL is a link to its own text.
const arbSegment: fc.Arbitrary<Segment> = fc.oneof(
  {
    arbitrary: fc.record({ text: arbText, marks: fc.constant(['code']), href: fc.constant(null) }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      text: arbText,
      marks: fc.subarray(['bold', 'italic', 'strike']),
      href: fc.option(fc.constantFrom(...HREFS), { nil: null, freq: 2 }),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(...HREFS).map((href) => ({ text: href, marks: [], href })),
    weight: 1,
  },
)

type Op =
  | { kind: 'move'; at: number }
  | { kind: 'select'; a: number; b: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight' }

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant('move' as const), at: fc.nat() }), weight: 3 },
  {
    arbitrary: fc.record({ kind: fc.constant('select' as const), a: fc.nat(), b: fc.nat() }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      text: fc.constantFrom('x', 'y ', '#'),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('key' as const),
      key: fc.constantFrom(
        'Backspace' as const,
        'Delete' as const,
        'ArrowLeft' as const,
        'ArrowRight' as const,
      ),
    }),
    weight: 4,
  },
)

function createEditor(level: number, segments: Segment[], reveal: boolean): Editor {
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
      ...(reveal ? [MarkdownReveal] : []),
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: level === 0 ? 'paragraph' : 'heading',
          ...(level === 0 ? {} : { attrs: { level } }),
          content: segments.map((s) => ({
            type: 'text',
            text: s.text,
            marks: [
              ...s.marks.map((type) => ({ type })),
              ...(s.href ? [{ type: 'link', attrs: { href: s.href } }] : []),
            ],
          })),
        },
      ],
    },
  })
  editors.push({ editor, host })
  return editor
}

/** A position inside the one textblock, from a random number. */
function inBlock(ed: Editor, n: number): number {
  return 1 + (n % (ed.state.doc.content.size - 1))
}

function pressKey(ed: Editor, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key })
  return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false
}

/** Type as the keyboard does: the editor's text-input handlers first, else an insert. */
function typeKey(ed: Editor, text: string): boolean {
  const { from, to } = ed.state.selection
  const handled =
    ed.view.someProp('handleTextInput', (f) =>
      f(ed.view, from, to, text, () => ed.state.tr.insertText(text, from, to)),
    ) ?? false
  if (!handled) ed.view.dispatch(ed.state.tr.insertText(text))
  return handled
}

/** The caret and what typing carries, copied from the revealing editor. */
function copyCaret(revealing: Editor, plain: Editor): void {
  const { selection, storedMarks } = revealing.state
  const stored = storedMarks?.map((m) => plain.schema.mark(m.type.name, m.attrs)) ?? null
  plain.view.dispatch(
    plain.state.tr
      .setSelection(TextSelection.create(plain.state.doc, selection.anchor, selection.head))
      .setStoredMarks(stored),
  )
}

/** The heading the plain editor's caret is in, set to `level`, 0 a paragraph, as an undo step of its own. */
function setLevel(plain: Editor, level: number): void {
  const chain = plain.chain().command(({ tr }) => {
    closeHistory(tr)
    return true
  })
  if (level === 0) chain.setParagraph().run()
  else chain.setNode('heading', { level }).run()
  plain.view.dispatch(closeHistory(plain.state.tr))
}

function deleteMarker(revealing: Editor, plain: Editor, key: 'Backspace' | 'Delete'): void {
  const { anchor, head } = revealing.state.selection
  const marker = markerBesideCaret(revealing.state, key === 'Backspace' ? 'before' : 'after')
  if (!marker) {
    for (const ed of [revealing, plain]) pressKey(ed, key)
    return
  }
  expect(pressKey(revealing, key)).toBe(true)
  if (marker.kind === 'heading') {
    setLevel(plain, marker.level - 1)
    copyCaret(revealing, plain)
    return
  }
  // The user deleted the drawn marker of this mark: in the plain editor, unmark its range.
  const name = marker.run.mark.type.name
  if (name === 'link') {
    plain
      .chain()
      .setTextSelection(marker.run.from)
      .extendMarkRange('link', { href: marker.run.mark.attrs['href'] })
      .unsetMark('link')
      .setTextSelection({ from: anchor, to: head })
      .run()
    return
  }
  plain
    .chain()
    .extendMarkRange(name)
    .unsetMark(name)
    .setTextSelection({ from: anchor, to: head })
    .run()
}

function apply(revealing: Editor, plain: Editor, op: Op): void {
  const both = [revealing, plain]
  if (op.kind === 'move') {
    for (const ed of both) ed.commands.setTextSelection(inBlock(ed, op.at))
    return
  }
  if (op.kind === 'select') {
    for (const ed of both) {
      ed.commands.setTextSelection({ from: inBlock(ed, op.a), to: inBlock(ed, op.b) })
    }
    return
  }
  if (op.kind === 'type') {
    const marker = markerBesideCaret(revealing.state, 'after')
    const raises =
      op.text === '#' &&
      marker?.kind === 'heading' &&
      isOutsideHeadingMarker(revealing.state.selection)
    expect(typeKey(revealing, op.text)).toBe(raises)
    if (!raises) {
      typeKey(plain, op.text)
      return
    }
    // `#` left of the heading's `#` run: one level up, to 6.
    if (marker.level < 6) setLevel(plain, marker.level + 1)
    copyCaret(revealing, plain)
    return
  }
  if (op.key === 'Backspace' || op.key === 'Delete') {
    deleteMarker(revealing, plain, op.key)
    return
  }
  const before = revealing.state.doc
  pressKey(revealing, op.key)
  // An edit is the editor's own (a bare URL's exit at the block end), which the plain editor makes too.
  if (!revealing.state.doc.eq(before)) {
    pressKey(plain, op.key)
    return
  }
  // Otherwise the arrow moved only the caret, or its side of a marker: copy that.
  copyCaret(revealing, plain)
}

describe('MarkdownReveal never changes what is saved', () => {
  it('saves the same Markdown and undo history as the plain editor under the same edits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.array(arbSegment, { minLength: 1, maxLength: 8 }),
        fc.array(arbOp, { minLength: 1, maxLength: 12 }),
        (level, segments, ops) => {
          const revealing = createEditor(level, segments, true)
          const plain = createEditor(level, segments, false)
          for (const op of ops) {
            apply(revealing, plain, op)
            expect(serialize(revealing.getJSON() as DocNode)).toBe(
              serialize(plain.getJSON() as DocNode),
            )
            expect(undoDepth(revealing.state)).toBe(undoDepth(plain.state))
          }
          destroyEditors()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
