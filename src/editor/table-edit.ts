/**
 * The edits a table's own handles make (#6607), for block mode's roving editor and
 * page mode's document alike: move the caret's row or column, sort the body rows by
 * the caret's column, and add a row or column at the end. Insert and delete are
 * TipTap's table commands, run as `TableOpsSelector` runs them.
 *
 * A Markdown table's first row is its header (`serializeTable`), so a row move or a
 * sort leaves row 0 where it is. Each edit is one transaction that starts its own
 * history event, so one undo takes back exactly one edit, and the caret lands in the
 * moved or added cell, where the handles then sit.
 */

import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state'
import { addColumn, addRow, cellAround, TableMap } from '@tiptap/pm/tables'

import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { isMac } from '@/lib/platform'
import { type SortDirection, sortedRowOrder } from '@/lib/table-sort'

/** Where the caret is in its table, by row and column index. */
export interface TableCaret {
  tablePos: number
  row: number
  col: number
  rows: number
  cols: number
}

export function tableCaret(state: EditorState): TableCaret | null {
  const $cell = cellAround(state.selection.$head)
  if ($cell === null) return null
  const table = $cell.node(-1)
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const { top, left } = map.findCell($cell.pos - tableStart)
  return { tablePos: tableStart - 1, row: top, col: left, rows: map.height, cols: map.width }
}

/** Puts the caret at the start of the cell at `row`, `col` of the table at `tablePos`. */
function caretIn(tr: Transaction, tablePos: number, row: number, col: number): Transaction {
  const table = tr.doc.nodeAt(tablePos) as PMNode
  const map = TableMap.get(table)
  const cellPos = tablePos + 1 + (map.map[row * map.width + col] as number)
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)))
}

function dispatch(editor: Editor, tr: Transaction): true {
  editor.view.dispatch(closeHistory(tr).scrollIntoView())
  editor.view.focus()
  return true
}

/**
 * Replaces the caret's table with `rows`, as one edit, and puts the caret at `row`,
 * `col` of it. A move or sort is this rebuild rather than prosemirror-tables'
 * `moveTableRow` / `moveTableColumn`, which rebuild each cell with `createChecked` and
 * throw on the content-less cell the parser makes of an empty Markdown cell. A Markdown
 * table has no merged cells, so every row holds one cell per column.
 */
function replaceRows(
  editor: Editor,
  at: TableCaret,
  rows: readonly PMNode[],
  row: number,
  col: number,
): boolean {
  const table = editor.state.doc.nodeAt(at.tablePos) as PMNode
  const tr = editor.state.tr.replaceWith(
    at.tablePos,
    at.tablePos + table.nodeSize,
    table.copy(Fragment.from(rows)),
  )
  return dispatch(editor, caretIn(tr, at.tablePos, row, col))
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach((child) => out.push(child))
  return out
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items]
  out.splice(to, 0, ...out.splice(from, 1))
  return out
}

/** Moves the caret's body row to body index `to`; the header row never moves. */
export function moveTableRowTo(editor: Editor, to: number): boolean {
  const at = tableCaret(editor.state)
  if (at === null || at.row === 0 || to < 1 || to >= at.rows || to === at.row) return false
  const rows = childrenOf(editor.state.doc.nodeAt(at.tablePos) as PMNode)
  return replaceRows(editor, at, moved(rows, at.row, to), to, at.col)
}

/**
 * Moves the caret's column, header cell and alignment with it, to index `to`. A row
 * written with fewer cells than the table is wide is filled out first, so its cells
 * stay under their headers.
 */
export function moveTableColumnTo(editor: Editor, to: number): boolean {
  const at = tableCaret(editor.state)
  if (at === null || to < 0 || to >= at.cols || to === at.col) return false
  const rows = childrenOf(editor.state.doc.nodeAt(at.tablePos) as PMNode).map((row) => {
    const cells = childrenOf(row)
    const type = (row.firstChild as PMNode).type
    while (cells.length < at.cols) cells.push(type.create())
    return row.copy(Fragment.from(moved(cells, at.col, to)))
  })
  return replaceRows(editor, at, rows, at.row, to)
}

/** Rewrites the body rows in the caret column's order; nothing when they already are. */
export function sortTableByColumn(editor: Editor, direction: SortDirection): boolean {
  const at = tableCaret(editor.state)
  if (at === null) return false
  const [header, ...body] = childrenOf(editor.state.doc.nodeAt(at.tablePos) as PMNode)
  const cells = body.map((row) => row.maybeChild(at.col)?.textContent ?? '')
  const order = sortedRowOrder(cells, direction)
  if (order.every((from, to) => from === to)) return false
  const rows = [header as PMNode, ...order.map((i) => body[i] as PMNode)]
  return replaceRows(editor, at, rows, 0, at.col)
}

/** The whole table as prosemirror-tables' `addRow` / `addColumn` take it. */
function wholeTable(state: EditorState, at: TableCaret) {
  const table = state.doc.nodeAt(at.tablePos) as PMNode
  const map = TableMap.get(table)
  const tableStart = at.tablePos + 1
  return { map, table, tableStart, left: 0, top: 0, right: map.width, bottom: map.height }
}

/** Adds an empty body row under the last one, the caret in its cell under the caret's. */
export function addTableRowAtEnd(editor: Editor): boolean {
  const at = tableCaret(editor.state)
  if (at === null) return false
  const tr = addRow(editor.state.tr, wholeTable(editor.state, at), at.rows)
  return dispatch(editor, caretIn(tr, at.tablePos, at.rows, at.col))
}

/** Adds an empty column after the last one, the caret in its cell beside the caret's. */
export function addTableColumnAtEnd(editor: Editor): boolean {
  const at = tableCaret(editor.state)
  if (at === null) return false
  const tr = addColumn(editor.state.tr, wholeTable(editor.state, at), at.cols)
  return dispatch(editor, caretIn(tr, at.tablePos, at.row, at.cols))
}

/**
 * The move chords in a table cell, read through the keyboard config so a rebind is
 * honoured. A chord at the table's edge is still taken, so it does not fall
 * through to the browser. On macOS the default Option+Shift+arrows stay the
 * system's selection keys: a Mac user moves from the menus, by drag, or rebinds.
 */
export const TableMoveKeys = Extension.create({
  name: 'tableMoveKeys',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            const at = tableCaret(view.state)
            if (at === null) return false
            // macOS extends the selection by word and paragraph with Option+Shift+arrows.
            if (isMac() && event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
              return false
            }
            if (matchesShortcutBinding(event, 'moveTableRowUp')) moveTableRowTo(editor, at.row - 1)
            else if (matchesShortcutBinding(event, 'moveTableRowDown')) {
              moveTableRowTo(editor, at.row + 1)
            } else if (matchesShortcutBinding(event, 'moveTableColumnLeft')) {
              moveTableColumnTo(editor, at.col - 1)
            } else if (matchesShortcutBinding(event, 'moveTableColumnRight')) {
              moveTableColumnTo(editor, at.col + 1)
            } else return false
            return true
          },
        },
      }),
    ]
  },
})
