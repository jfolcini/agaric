/**
 * Page mode's paste of Markdown text (`page-paste.ts`): the blocks it reads
 * as, at their depths with their marks, and the pastes it leaves to
 * ProseMirror.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  idMinter,
  openPage,
  rowsOf,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { pastedBlocks } from '@/editor/page-mode/page-paste'
import { leadingTask } from '@/editor/page-mode/page-tasks'

const A = blockId(1)
const B = blockId(2)
const NEW = idMinter()
const [N1, N2, N3] = [NEW(), NEW(), NEW()]

let editor: ReturnType<typeof openPage> | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(rows: Parameters<typeof openPage>[0]) {
  editor = openPage(rows, idMinter())
  return editor
}

/** Paste `text` as Ctrl+V does with only text on the clipboard; `pasteText` is Shift's plain paste. */
function paste(ed: Editor, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [] },
  })
  ed.view.dom.dispatchEvent(event)
}

describe('pastedBlocks', () => {
  it('reads list items, nested ones one deeper, and the paragraph after them', () => {
    const blocks = pastedBlocks('- a\n  - b\n    - c\n- d\n\npara')
    expect(blocks.map((b) => b.depth)).toEqual([0, 1, 2, 0, 0])
    expect(blocks.map((b) => b.content[0]?.content?.[0]?.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'para',
    ])
  })

  it('reads a heading and a fence as a block each, the fence’s lines its own', () => {
    const blocks = pastedBlocks('# Head\n\n```\n- not an item\n```')
    expect(blocks.map((b) => b.content.map((node) => node.type))).toEqual([
      ['heading'],
      ['codeBlock'],
    ])
  })

  it('reads nothing from lines that hold no Markdown', () => {
    expect(pastedBlocks('from\noutside')).toEqual([])
  })
})

describe('pasting Markdown text in page mode', () => {
  it('makes each item and paragraph a new block, its marks marks, not escaped text', () => {
    const ed = open([
      [A, 0, ''],
      [B, 0, 'after'],
    ])
    caret(ed, 0, 0)

    paste(ed, '- a\n- b\n\npara **x** [l](https://x.com)')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'a'],
      [N1, 0, 'b'],
      [N2, 0, 'para **x** [l](https://x.com)'],
      [B, 0, 'after'],
    ])
  })

  it('nests the items under the depth of the block pasted into', () => {
    const ed = open([
      [A, 0, 'top'],
      [B, 1, ''],
    ])
    caret(ed, 1, 0)

    paste(ed, '- a\n  - b\n    - c\n- d')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'top'],
      [B, 1, 'a'],
      [N1, 2, 'b'],
      [N2, 3, 'c'],
      [N3, 1, 'd'],
    ])
  })

  it('joins the first block to the text before the cursor, and the text after it to the last', () => {
    const ed = open([[A, 0, 'beforeafter']])
    caret(ed, 0, 6)

    paste(ed, '- a\n- b')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'beforea'],
      [N1, 0, 'bafter'],
    ])
  })

  it('makes a heading and a fence blocks of their own, from an empty block', () => {
    const ed = open([[A, 0, '']])
    caret(ed, 0, 0)

    paste(ed, '# Title\n\n```\n- x\n```')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, '# Title'],
      [N1, 0, '```\n- x\n```'],
    ])
  })

  it('keeps a task item’s checkbox as text, which the block takes as its state once left', () => {
    const ed = open([[A, 0, '']])
    caret(ed, 0, 0)

    paste(ed, '- [ ] buy\n- [x] sold')

    const tasks: Array<ReturnType<typeof leadingTask>> = []
    ed.state.doc.forEach((node) => tasks.push(leadingTask(node)))
    expect(tasks.map((task) => task?.todoState)).toEqual(['TODO', 'DONE'])
  })

  it('leaves one line of text inline, at the cursor', () => {
    const ed = open([[A, 0, 'ab']])
    caret(ed, 0, 1)

    paste(ed, 'x')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'axb']])
  })

  it('reads one bullet line as its item, joined at the cursor, and one task line as a task', () => {
    const ed = open([
      [A, 0, 'ab'],
      [B, 0, ''],
    ])
    caret(ed, 0, 1)
    paste(ed, '- x')
    caret(ed, 1, 0)
    paste(ed, '- [ ] buy')

    expect(ed.state.doc.child(0).textContent).toBe('axb')
    expect(leadingTask(ed.state.doc.child(1))?.todoState).toBe('TODO')
  })

  it('leaves lines with no Markdown to ProseMirror, a block each', () => {
    const ed = open([[A, 0, '']])
    caret(ed, 0, 0)

    paste(ed, 'from\noutside')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'from'],
      [N1, 0, 'outside'],
    ])
  })

  it('leaves a plain-text paste (Shift) as its lines', () => {
    const ed = open([[A, 0, '']])
    caret(ed, 0, 0)

    ed.view.pasteText('- a\n- b')

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, '\\- a'],
      [N1, 0, '\\- b'],
    ])
  })

  it('leaves text pasted into a list in a block’s content to that list', () => {
    const ed = open([[A, 0, '- in a list']])
    caret(ed, 0, 2)

    paste(ed, '- a\n- b')

    expect(rowsOf(ed.state.doc)).toHaveLength(1)
  })
})
