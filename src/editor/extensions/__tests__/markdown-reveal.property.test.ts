/**
 * #5689 — the revealed markers never change what is saved. One editor reveals
 * Markdown syntax, the other is the plain WYSIWYG editor. Random paragraphs of
 * nested and adjacent marks get the same random caret moves, selections and
 * typing in both; deleting a marker in the revealing editor is matched by
 * removing that mark from its range in the other (TipTap's own
 * `extendMarkRange` + `unsetMark`); crossing a marker changes only the caret's
 * stored marks, which the other editor copies. After every edit both save the
 * same Markdown and hold the same undo history.
 */

import { Editor } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import Document from '@tiptap/extension-document'
import History from '@tiptap/extension-history'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import { undoDepth } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MarkdownReveal } from '@/editor/extensions/markdown-reveal'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { serialize } from '@/editor/markdown-serializer'
import { markerBesideCaret } from '@/editor/revealed-markers'
import type { DocNode } from '@/editor/types'
import { PREFERENCES, writePreference } from '@/lib/preferences'

const NUM_RUNS = Number(process.env['SWEEP_RUNS'] ?? 200)

const editors: Editor[] = []

beforeEach(() => {
  localStorage.clear()
  writePreference(PREFERENCES.revealMarkdownSyntax, true)
})

afterEach(() => {
  for (const ed of editors.splice(0)) ed.destroy()
})

interface Segment {
  text: string
  marks: string[]
}

// Code excludes every other mark, so a segment is code alone or any emphasis subset.
const arbSegment: fc.Arbitrary<Segment> = fc.record({
  text: fc
    .array(fc.constantFrom('a', 'b', ' '), { minLength: 1, maxLength: 4 })
    .map((cs) => cs.join('')),
  marks: fc.oneof(
    fc.subarray(['code'], { minLength: 1 }),
    fc.subarray(['bold', 'italic', 'strike']),
  ),
})

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
    arbitrary: fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('x', 'y ') }),
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

function createEditor(segments: Segment[], reveal: boolean): Editor {
  const ed = new Editor({
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
      ...(reveal ? [MarkdownReveal] : []),
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: segments.map((s) => ({
            type: 'text',
            text: s.text,
            marks: s.marks.map((type) => ({ type })),
          })),
        },
      ],
    },
  })
  editors.push(ed)
  return ed
}

/** A position inside the one paragraph, from a random number. */
function inParagraph(ed: Editor, n: number): number {
  return 1 + (n % (ed.state.doc.content.size - 1))
}

function pressKey(ed: Editor, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key })
  return ed.view.someProp('handleKeyDown', (f) => f(ed.view, event)) ?? false
}

function apply(revealing: Editor, plain: Editor, op: Op): void {
  const both = [revealing, plain]
  if (op.kind === 'move') {
    for (const ed of both) ed.commands.setTextSelection(inParagraph(ed, op.at))
    return
  }
  if (op.kind === 'select') {
    for (const ed of both) {
      ed.commands.setTextSelection({ from: inParagraph(ed, op.a), to: inParagraph(ed, op.b) })
    }
    return
  }
  if (op.kind === 'type') {
    for (const ed of both) ed.view.dispatch(ed.state.tr.insertText(op.text))
    return
  }
  const { anchor, head } = revealing.state.selection
  if (op.key === 'Backspace' || op.key === 'Delete') {
    const marker = markerBesideCaret(revealing.state, op.key === 'Backspace' ? 'before' : 'after')
    if (!marker) {
      for (const ed of both) pressKey(ed, op.key)
      return
    }
    expect(pressKey(revealing, op.key)).toBe(true)
    // The user deleted the drawn marker of this mark: in the plain editor, unmark its range.
    const name = marker.run.mark.type.name
    plain
      .chain()
      .extendMarkRange(name)
      .unsetMark(name)
      .setTextSelection({ from: anchor, to: head })
      .run()
    return
  }
  const before = revealing.state.doc
  pressKey(revealing, op.key)
  // An edit is the editor's own (code's exit at the block end), which the plain editor makes too.
  if (!revealing.state.doc.eq(before)) {
    pressKey(plain, op.key)
    return
  }
  // Otherwise the arrow moved only the caret, or its side of a marker: copy that.
  const { selection, storedMarks } = revealing.state
  const stored = storedMarks?.map((m) => plain.schema.mark(m.type.name, m.attrs)) ?? null
  plain.view.dispatch(
    plain.state.tr
      .setSelection(TextSelection.create(plain.state.doc, selection.anchor, selection.head))
      .setStoredMarks(stored),
  )
}

describe('MarkdownReveal never changes what is saved', () => {
  it('saves the same Markdown and undo history as the plain editor under the same edits', () => {
    fc.assert(
      fc.property(
        fc.array(arbSegment, { minLength: 1, maxLength: 8 }),
        fc.array(arbOp, { minLength: 1, maxLength: 12 }),
        (segments, ops) => {
          const revealing = createEditor(segments, true)
          const plain = createEditor(segments, false)
          for (const op of ops) {
            apply(revealing, plain, op)
            expect(serialize(revealing.getJSON() as DocNode)).toBe(
              serialize(plain.getJSON() as DocNode),
            )
            expect(undoDepth(revealing.state)).toBe(undoDepth(plain.state))
          }
          for (const ed of editors.splice(0)) ed.destroy()
        },
      ),
      { numRuns: NUM_RUNS },
    )
  })
})
