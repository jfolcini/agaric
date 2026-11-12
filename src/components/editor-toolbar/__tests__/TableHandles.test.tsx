/**
 * The table's own handles (#6607) on a real editor: shown only while the focused
 * editor's caret is in a table, a press on a handle opens its row's or column's
 * operations, a drag moves the row or column to where it is dropped (the header row
 * stays), and the add buttons add a row or column at the end. Each result is the
 * Markdown the block saves. The save, navigation and touch paths are in
 * `e2e/table-handles.spec.ts`.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { TableHandles } from '@/components/editor-toolbar/TableHandles'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { contentExtensions } from '@/editor/use-roving-editor'

const TABLE = '| h1 | h2 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |'

let editor: Editor | undefined
let host: HTMLElement | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  host?.remove()
  vi.restoreAllMocks()
})

function setup(markdown = TABLE): Editor {
  host = document.createElement('div')
  document.body.append(host)
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
  editor = new Editor({
    element: host,
    extensions: [Document, ...Object.values(groups).flat()],
    content: parse(markdown) as unknown as JSONContent,
  })
  return editor
}

function caretIn(ed: Editor, text: string): void {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === 'paragraph' && node.textContent === text) at = pos + 1
    return at === -1
  })
  expect(at, `no cell holds ${text}`).toBeGreaterThan(0)
  act(() => {
    ed.commands.setTextSelection(at)
    // TipTap's `focus` command waits a frame; the view's own focus is at once.
    ed.view.dom.focus()
  })
}

const md = (ed: Editor) => serialize(ed.getJSON() as DocNode)

/** Lays the rows out 20 px apart and the columns 100 px apart, as a browser would. */
function layOut(): void {
  vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLTableRowElement,
  ) {
    return new DOMRect(0, this.rowIndex * 20, 200, 20)
  })
  vi.spyOn(HTMLTableCellElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLTableCellElement,
  ) {
    const row = this.parentElement as HTMLTableRowElement
    return new DOMRect(this.cellIndex * 100, row.rowIndex * 20, 100, 20)
  })
}

/** Drags `handle` from `from` to `to`; whether the drop line showed on the way. */
function drag(
  handle: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to.x, clientY: to.y })
  const lineShown = screen.queryByTestId('table-drop-line') !== null
  fireEvent.pointerUp(handle, { button: 0, pointerId: 1, clientX: to.x, clientY: to.y })
  return lineShown
}

describe('TableHandles', () => {
  it('shows nothing until the focused caret is in a table', () => {
    const ed = setup(`text\n\n${TABLE}`)
    render(<TableHandles editor={ed} />)
    expect(screen.queryByTestId('table-handles')).toBeNull()
    caretIn(ed, 'text')
    expect(screen.queryByTestId('table-handles')).toBeNull()
    caretIn(ed, 'a')
    expect(screen.getByTestId('table-handles')).toBeInTheDocument()
    act(() => {
      ed.view.dom.blur()
    })
    expect(screen.queryByTestId('table-handles')).toBeNull()
  })

  it('names its four controls and has no a11y violations', async () => {
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'b')
    for (const name of ['Row actions', 'Column actions', 'Add row', 'Add column']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(await axe(screen.getByTestId('table-handles'))).toHaveNoViolations()
  })

  it("a press on the row handle opens the row's operations, which act on the caret's row", async () => {
    const user = userEvent.setup()
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'a')
    await user.click(screen.getByRole('button', { name: 'Row actions' }))
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /Move row down/ }))
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| b | 2 |\n| a | 1 |\n| c | 3 |')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it("a press on the column handle opens the column's operations", async () => {
    const user = userEvent.setup()
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, '2')
    await user.click(screen.getByRole('button', { name: 'Column actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sort descending' }))
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| c | 3 |\n| b | 2 |\n| a | 1 |')
  })

  it('dragging the row handle moves the row to the row it is dropped on', () => {
    layOut()
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'a')
    expect(
      drag(screen.getByRole('button', { name: 'Row actions' }), { x: 0, y: 30 }, { x: 0, y: 72 }),
    ).toBe(true)
    expect(screen.queryByTestId('table-drop-line')).toBeNull()
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| b | 2 |\n| c | 3 |\n| a | 1 |')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a row dragged onto the header lands under it; the header row shows nowhere to land', () => {
    layOut()
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'c')
    drag(screen.getByRole('button', { name: 'Row actions' }), { x: 0, y: 70 }, { x: 0, y: 2 })
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| c | 3 |\n| a | 1 |\n| b | 2 |')
    caretIn(ed, 'h1')
    expect(
      drag(screen.getByRole('button', { name: 'Row actions' }), { x: 0, y: 10 }, { x: 0, y: 70 }),
    ).toBe(false)
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| c | 3 |\n| a | 1 |\n| b | 2 |')
  })

  it('dragging the column handle moves the column', () => {
    layOut()
    const ed = setup()
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'h2')
    drag(screen.getByRole('button', { name: 'Column actions' }), { x: 150, y: 0 }, { x: 20, y: 0 })
    expect(md(ed)).toBe('| h2 | h1 |\n| --- | --- |\n| 1 | a |\n| 2 | b |\n| 3 | c |')
  })

  it('the add buttons add a row under the last and a column after the last', async () => {
    const user = userEvent.setup()
    const ed = setup('| h1 | h2 |\n| --- | --- |\n| a | 1 |')
    render(<TableHandles editor={ed} />)
    caretIn(ed, 'a')
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(md(ed)).toBe('| h1 | h2 |\n| --- | --- |\n| a | 1 |\n|  |  |')
    await user.click(screen.getByRole('button', { name: 'Add column' }))
    expect(md(ed)).toBe('| h1 | h2 |  |\n| --- | --- | --- |\n| a | 1 |  |\n|  |  |  |')
  })
})
