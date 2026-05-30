import type React from 'react'

import type {
  ParagraphNode,
  TableCellNode,
  TableHeaderNode,
  TableNode,
  TableRowNode,
} from '../../../editor/types'
import type { RenderContext } from '../context'
import { renderInlineContent } from './inline'

/**
 * Render a markdown table block in VIEW (read) mode.
 *
 * #215 — before this, `renderBlock` had no `table` case, so a block whose
 * content parsed to a `table` node fell through to the `default: null`
 * branch and rendered as nothing. A user could insert a table, type into
 * it while the block was focused (the TipTap editor mounts real table
 * nodes), then click away and watch the whole table vanish. This renderer
 * closes that gap by mirroring the parser's structure
 * (`markdown-parse.ts` → `buildTableRows`/`buildTableCell`):
 *   - row 0's cells are `tableHeader`; the rest are `tableCell`
 *   - each cell holds `ParagraphNode[]`, whose inline content is rendered
 *     with the shared `renderInlineContent` (so tags/links/marks inside a
 *     cell resolve the same way they do everywhere else).
 *
 * Header cells are grouped into a `<thead>`; the remaining rows into a
 * `<tbody>`. Styling is inline Tailwind (there is no global table CSS) so
 * the view-mode table reads as a real table — bordered, collapsed,
 * padded, header emphasised — instead of unstyled inline text.
 */
export function renderTableBlock(
  block: TableNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | null {
  const rows = block.content ?? []
  if (rows.length === 0) return null

  const renderCellChildren = (
    cell: TableCellNode | TableHeaderNode,
    cellKey: string,
  ): React.ReactNode[] => {
    const paragraphs = cell.content ?? []
    const children: React.ReactNode[] = []
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p] as ParagraphNode | undefined
      if (para?.content) {
        children.push(...renderInlineContent(para.content, `${cellKey}-${p}`, ctx))
      }
    }
    return children
  }

  const renderRow = (row: TableRowNode, rowKey: string): React.ReactElement => {
    const cells = row.content ?? []
    return (
      <tr key={rowKey}>
        {cells.map((cell, c) => {
          const cellKey = `${rowKey}-${c}`
          const children = renderCellChildren(cell, cellKey)
          return cell.type === 'tableHeader' ? (
            <th
              key={cellKey}
              scope="col"
              className="border border-border bg-muted/60 px-3 py-1.5 text-left text-sm font-medium align-top"
            >
              {children}
            </th>
          ) : (
            <td key={cellKey} className="border border-border px-3 py-1.5 text-sm align-top">
              {children}
            </td>
          )
        })}
      </tr>
    )
  }

  // Row 0 is the header row when it carries header cells (parser convention).
  const firstRow = rows[0]
  const hasHeader = (firstRow?.content ?? []).some((cell) => cell.type === 'tableHeader')
  const headerRows = hasHeader && firstRow ? [firstRow] : []
  const bodyRows = hasHeader ? rows.slice(1) : rows

  return (
    <div key={key} className="my-1 overflow-x-auto">
      <table data-testid="rich-table" className="w-auto border-collapse border border-border">
        {headerRows.length > 0 && (
          <thead>{headerRows.map((row, r) => renderRow(row, `${key}-h-${r}`))}</thead>
        )}
        <tbody>{bodyRows.map((row, r) => renderRow(row, `${key}-r-${r}`))}</tbody>
      </table>
    </div>
  )
}
