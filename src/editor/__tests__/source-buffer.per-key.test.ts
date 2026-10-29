/**
 * What a key costs in the *Edit as Markdown* buffer (#5691 G3) at page mode's
 * block cap (`PAGE_MODE_BLOCK_CAP`). The Document dialect is read whole
 * (`parseDocument`) wherever a block is looked up, so the outline keys read
 * the buffer once for all the lines a selection touches, never once a line.
 *
 * Opt-in timing: `AGARIC_PERF=1 npx vitest run src/editor/__tests__/source-buffer.per-key.test.ts`
 * prints, at 100 and at the cap's blocks, the median and p90 of a key typed (the
 * editor's own transaction), of the toolbar's state on each transaction (the
 * block at the cursor and its priority, `PageSourceToolbar`), and of a caret
 * move with that state. Node and happy-dom, not WebKitGTK: compare runs of
 * this file only, against each other.
 */

import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import { linesContent, sourceBufferExtensions, type SourceLines } from '@/editor/source-buffer'
import { blockAtCursor, blockProperty, indentRange } from '@/editor/source-buffer-blocks'
import { parseDocument } from '@/editor/source-buffer-document'
import { SourceBufferPickers } from '@/editor/source-buffer-pickers'

vi.mock('@/editor/source-buffer-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/source-buffer-document')>()
  return { ...actual, parseDocument: vi.fn(actual.parseDocument) }
})

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** Each kind of block in turn: a paragraph, a bullet, a numbered item, a task with a priority, a heading. */
const KINDS: Array<(i: number) => string[]> = [
  (i) => [`Paragraph ${i} with **bold** text and a [[Link]]`, ''],
  (i) => [`- bullet ${i}`],
  (i) => [`1. numbered ${i}`],
  (i) => [`- [ ] task ${i}`, '  priority:: 1', ''],
  (i) => [`## Heading ${i}`, ''],
]

function pageOf(blocks: number): SourceLines {
  const lines: string[] = []
  const lineIds: Array<string | null> = []
  for (let i = 0; i < blocks; i += 1) {
    ;(KINDS[i % KINDS.length] as (i: number) => string[])(i).forEach((line, j) => {
      lines.push(line)
      lineIds.push(j === 0 ? `01J${String(i).padStart(23, '0')}` : null)
    })
  }
  return { text: lines.join('\n'), lineIds }
}

function open(blocks: number): Editor {
  const page = pageOf(blocks)
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...sourceBufferExtensions(page.lineIds), SourceBufferPickers],
    content: linesContent(page),
  })
  return editor
}

/** The position `offset` characters into line `index`. */
function at(ed: Editor, index: number, offset: number): number {
  let pos = 1
  for (let i = 0; i < index; i += 1) pos += ed.state.doc.child(i).nodeSize
  return pos + offset
}

describe('the outline keys on a long buffer', () => {
  it('read the buffer once for a selection over every block, however many lines it touches', () => {
    const ed = open(PAGE_MODE_BLOCK_CAP)
    const last = ed.state.doc.childCount - 1
    vi.mocked(parseDocument).mockClear()

    indentRange(1, last)(ed.state, ed.view.dispatch)

    expect(vi.mocked(parseDocument).mock.calls).toHaveLength(1)
  })
})

/** Median and p90 of `run`, timed `count` times. */
function timed(run: () => void, count = 30): string {
  const times: number[] = []
  for (let i = 0; i < count; i += 1) {
    const start = performance.now()
    run()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const pick = (q: number) => (times[Math.floor(q * times.length)] as number).toFixed(1)
  return `${pick(0.5)} ms [p90 ${pick(0.9)}]`
}

describe.skipIf(process.env['AGARIC_PERF'] !== '1')('the cost of a key (opt-in)', () => {
  it.each([100, PAGE_MODE_BLOCK_CAP])('at %d blocks', (blocks) => {
    const ed = open(blocks)
    const middle = Math.floor(ed.state.doc.childCount / 2)
    ed.view.dispatch(
      ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, middle, 3))),
    )
    const toolbarState = () => {
      const block = blockAtCursor(ed.state)
      if (block !== null) blockProperty(ed.state.doc, block, 'priority')
    }
    let step = 1

    const key = timed(() => ed.view.dispatch(ed.state.tr.insertText('x')))
    const state = timed(toolbarState)
    const move = timed(() => {
      step = -step
      const head = ed.state.selection.head + step
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, head)))
      toolbarState()
    })

    console.info(
      `${blocks} blocks, ${ed.state.doc.childCount} lines: key ${key}, toolbar state ${state}, caret move with it ${move}`,
    )
  })
})
