/**
 * TableOpsSelector — the table row/column operations as a menu (#215, #6607).
 *
 * The toolbar's table button (shown only when the selection is inside a table
 * cell) and page mode's table bubble show every operation; the table's own row
 * and column handles (`TableHandles`) show the row's or the column's. Each acts
 * on the cell the caret is in: TipTap's table commands insert and delete, and
 * `table-edit.ts` moves and sorts. A move with nowhere to go is disabled, and
 * the header row neither moves nor is sorted.
 *
 * Like the other toolbar selectors it uses `onPointerDown` + `preventDefault`
 * so the click never blurs the editor — the caret the command operates on
 * stays intact.
 */

import type { Editor } from '@tiptap/react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpNarrowWide,
  ArrowUpToLine,
  type LucideIcon,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { shortcutHint } from '@/components/editor/block-context-menu/hints'
import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { toolbarMenuRowClass } from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  moveTableColumnTo,
  moveTableRowTo,
  sortTableByColumn,
  type TableCaret,
  tableCaret,
} from '@/editor/table-edit'
import { cn } from '@/lib/utils'

/** Which operations a menu shows: a handle's row or column, or all of them. */
export type TableOpsScope = 'row' | 'column' | 'table'

export interface TableOpsSelectorProps {
  editor: Editor
  onClose: () => void
  scope?: TableOpsScope
}

interface TableOp {
  id: string
  labelKey: string
  icon: LucideIcon
  scope: TableOpsScope
  run: (editor: Editor, at: TableCaret) => void
  /** False when the caret's cell gives the op nowhere to go; absent means always. */
  enabled?: (at: TableCaret) => boolean
  shortcutId?: string
  /** Destructive ops are grouped below a separator and tinted. */
  destructive?: boolean
}

const TABLE_OPS: ReadonlyArray<TableOp> = [
  {
    id: 'insert-row-above',
    labelKey: 'toolbar.tableInsertRowAbove',
    icon: ArrowUpToLine,
    scope: 'row',
    run: (e) => e.chain().focus().addRowBefore().run(),
  },
  {
    id: 'insert-row-below',
    labelKey: 'toolbar.tableInsertRowBelow',
    icon: ArrowDownToLine,
    scope: 'row',
    run: (e) => e.chain().focus().addRowAfter().run(),
  },
  {
    id: 'move-row-up',
    labelKey: 'toolbar.tableMoveRowUp',
    icon: ArrowUp,
    scope: 'row',
    run: (e, at) => moveTableRowTo(e, at.row - 1),
    enabled: (at) => at.row > 1,
    shortcutId: 'moveTableRowUp',
  },
  {
    id: 'move-row-down',
    labelKey: 'toolbar.tableMoveRowDown',
    icon: ArrowDown,
    scope: 'row',
    run: (e, at) => moveTableRowTo(e, at.row + 1),
    enabled: (at) => at.row > 0 && at.row < at.rows - 1,
    shortcutId: 'moveTableRowDown',
  },
  {
    id: 'insert-column-left',
    labelKey: 'toolbar.tableInsertColumnLeft',
    icon: ArrowLeftToLine,
    scope: 'column',
    run: (e) => e.chain().focus().addColumnBefore().run(),
  },
  {
    id: 'insert-column-right',
    labelKey: 'toolbar.tableInsertColumnRight',
    icon: ArrowRightToLine,
    scope: 'column',
    run: (e) => e.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'move-column-left',
    labelKey: 'toolbar.tableMoveColumnLeft',
    icon: ArrowLeft,
    scope: 'column',
    run: (e, at) => moveTableColumnTo(e, at.col - 1),
    enabled: (at) => at.col > 0,
    shortcutId: 'moveTableColumnLeft',
  },
  {
    id: 'move-column-right',
    labelKey: 'toolbar.tableMoveColumnRight',
    icon: ArrowRight,
    scope: 'column',
    run: (e, at) => moveTableColumnTo(e, at.col + 1),
    enabled: (at) => at.col < at.cols - 1,
    shortcutId: 'moveTableColumnRight',
  },
  {
    id: 'sort-ascending',
    labelKey: 'toolbar.tableSortAscending',
    icon: ArrowUpNarrowWide,
    scope: 'column',
    run: (e) => sortTableByColumn(e, 'asc'),
  },
  {
    id: 'sort-descending',
    labelKey: 'toolbar.tableSortDescending',
    icon: ArrowDownWideNarrow,
    scope: 'column',
    run: (e) => sortTableByColumn(e, 'desc'),
  },
  {
    id: 'delete-row',
    labelKey: 'toolbar.tableDeleteRow',
    icon: Trash2,
    scope: 'row',
    run: (e) => e.chain().focus().deleteRow().run(),
    destructive: true,
  },
  {
    id: 'delete-column',
    labelKey: 'toolbar.tableDeleteColumn',
    icon: Trash2,
    scope: 'column',
    run: (e) => e.chain().focus().deleteColumn().run(),
    destructive: true,
  },
  {
    id: 'delete-table',
    labelKey: 'toolbar.tableDeleteTable',
    icon: Trash2,
    scope: 'table',
    run: (e) => e.chain().focus().deleteTable().run(),
    destructive: true,
  },
]

const MENU_LABEL: Record<TableOpsScope, string> = {
  row: 'toolbar.tableRowActions',
  column: 'toolbar.tableColumnActions',
  table: 'toolbar.tableOps',
}

export function TableOpsSelector({
  editor,
  onClose,
  scope = 'table',
}: TableOpsSelectorProps): React.ReactElement {
  const { t } = useTranslation()
  const at = tableCaret(editor.state)
  const ops = scope === 'table' ? TABLE_OPS : TABLE_OPS.filter((op) => op.scope === scope)
  const firstDestructiveIndex = ops.findIndex((op) => op.destructive)

  return (
    <div className="flex flex-col gap-0.5" role="menu" aria-label={t(MENU_LABEL[scope])}>
      {ops.map((op, i) => {
        const Icon = op.icon
        const enabled = at !== null && (op.enabled?.(at) ?? true)
        return (
          <div key={op.id} className="contents">
            {i === firstDestructiveIndex && <Separator className="my-1" />}
            <Button
              variant="ghost"
              size="sm"
              role="menuitem"
              disabled={!enabled}
              className={cn(
                toolbarMenuRowClass,
                'gap-2',
                op.destructive && 'text-destructive hover:text-destructive',
              )}
              data-testid={`table-op-${op.id}`}
              {...toolbarPressHandlers(() => {
                if (at !== null) op.run(editor, at)
                onClose()
              })}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(op.labelKey)}
              {op.shortcutId !== undefined && (
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {shortcutHint(op.shortcutId)}
                </span>
              )}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
