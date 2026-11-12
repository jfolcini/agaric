/**
 * Tests for TableOpsSelector (#215, #6607) — verifies each insert/delete item
 * runs the matching TipTap table command on the editor and then closes the
 * popover, and that the move and sort items rewrite the caret's table, off
 * where the caret's cell gives them nowhere to go.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TableOpsSelector } from '@/components/TableOpsSelector'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'

const TABLE = '| h1 | h2 |\n| --- | --- |\n| b | 2 |\n| a | 1 |'

/** A live editor on `TABLE`, the caret in the cell whose text is `text`. */
function liveEditor(text: string): Editor {
  const groups = contentExtensions({
    resolveTagName: (id) => id,
    resolveBlockTitle: (id) => id,
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
  const ed = new Editor({
    element: document.createElement('div'),
    extensions: [Document, ...Object.values(groups).flat()],
    content: parse(TABLE) as unknown as JSONContent,
  })
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === 'paragraph' && node.textContent === text) at = pos + 1
    return at === -1
  })
  ed.commands.setTextSelection(at)
  return ed
}

const live: Editor[] = []
afterEach(() => {
  for (const ed of live.splice(0)) ed.destroy()
})

// Each command returns the chain so calls can be fluent; `.run()` is the
// terminal. We assert the specific command spy fired.
const run = vi.fn()
const addRowBefore = vi.fn(() => ({ run }))
const addRowAfter = vi.fn(() => ({ run }))
const addColumnBefore = vi.fn(() => ({ run }))
const addColumnAfter = vi.fn(() => ({ run }))
const deleteRow = vi.fn(() => ({ run }))
const deleteColumn = vi.fn(() => ({ run }))
const deleteTable = vi.fn(() => ({ run }))

const chainObj = {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
}
const focus = vi.fn(() => chainObj)
const chain = vi.fn(() => ({ focus }))

// The caret in a body cell, so every insert and delete item is on.
const caretEditor = liveEditor('b')
const editor = { chain, state: caretEditor.state } as never

describe('TableOpsSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const cases: Array<[string, () => unknown]> = [
    ['table-op-insert-row-above', () => addRowBefore],
    ['table-op-insert-row-below', () => addRowAfter],
    ['table-op-insert-column-left', () => addColumnBefore],
    ['table-op-insert-column-right', () => addColumnAfter],
    ['table-op-delete-row', () => deleteRow],
    ['table-op-delete-column', () => deleteColumn],
    ['table-op-delete-table', () => deleteTable],
  ]

  for (const [testid, getSpy] of cases) {
    it(`runs the command for ${testid} and closes`, async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(<TableOpsSelector editor={editor} onClose={onClose} />)

      await user.click(screen.getByTestId(testid))

      expect(focus).toHaveBeenCalledTimes(1)
      expect(getSpy() as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  }

  it('renders all thirteen operations with a menu role', () => {
    render(<TableOpsSelector editor={editor} onClose={vi.fn()} />)
    expect(screen.getByRole('menu', { name: 'Table' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(13)
  })

  it("a handle's menu shows its row's or its column's operations", () => {
    const { unmount } = render(<TableOpsSelector editor={editor} scope="row" onClose={vi.fn()} />)
    expect(
      screen.getAllByRole('menuitem', { name: /row/ }).map((item) => item.dataset['testid']),
    ).toEqual([
      'table-op-insert-row-above',
      'table-op-insert-row-below',
      'table-op-move-row-up',
      'table-op-move-row-down',
      'table-op-delete-row',
    ])
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(5)
    unmount()
    render(<TableOpsSelector editor={editor} scope="column" onClose={vi.fn()} />)
    expect(screen.getByRole('menu', { name: 'Column actions' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((item) => item.dataset['testid'])).toEqual([
      'table-op-insert-column-left',
      'table-op-insert-column-right',
      'table-op-move-column-left',
      'table-op-move-column-right',
      'table-op-sort-ascending',
      'table-op-sort-descending',
      'table-op-delete-column',
    ])
  })

  it('moves the row, moves the column and sorts, closing each time', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const ed = liveEditor('b')
    live.push(ed)
    const view = () => render(<TableOpsSelector editor={ed as never} onClose={onClose} />)
    const md = () => serialize(ed.getJSON() as DocNode)

    let r = view()
    await user.click(screen.getByTestId('table-op-move-row-down'))
    expect(md()).toBe('| h1 | h2 |\n| --- | --- |\n| a | 1 |\n| b | 2 |')
    r.unmount()
    r = view()
    await user.click(screen.getByTestId('table-op-move-column-right'))
    expect(md()).toBe('| h2 | h1 |\n| --- | --- |\n| 1 | a |\n| 2 | b |')
    r.unmount()
    r = view()
    await user.click(screen.getByTestId('table-op-sort-descending'))
    expect(md()).toBe('| h2 | h1 |\n| --- | --- |\n| 2 | b |\n| 1 | a |')
    r.unmount()
    view()
    await user.click(screen.getByTestId('table-op-sort-ascending'))
    expect(md()).toBe('| h2 | h1 |\n| --- | --- |\n| 1 | a |\n| 2 | b |')
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['h1', ['table-op-move-row-up', 'table-op-move-row-down', 'table-op-move-column-left']],
    ['b', ['table-op-move-row-up', 'table-op-move-column-left']],
    ['1', ['table-op-move-row-down', 'table-op-move-column-right']],
  ])(
    'turns off a move with nowhere to go, and every row move on the header (caret in %s)',
    (text, off) => {
      const ed = liveEditor(text)
      live.push(ed)
      render(<TableOpsSelector editor={ed as never} onClose={vi.fn()} />)
      const disabled = screen
        .getAllByRole('menuitem')
        .filter((item) => (item as HTMLButtonElement).disabled)
        .map((item) => item.dataset['testid'])
      expect(disabled).toEqual(off)
    },
  )

  it('shows the move chords beside the moves', () => {
    render(<TableOpsSelector editor={editor} onClose={vi.fn()} />)
    expect(screen.getByTestId('table-op-move-row-up')).toHaveTextContent(/Move row up.*Alt/)
    expect(screen.getByTestId('table-op-move-column-right')).toHaveTextContent(
      /Move column right.*Alt/,
    )
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TableOpsSelector editor={editor} onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
