/**
 * TableOpsSelector — popover content for table row/column operations (#215).
 *
 * TipTap's table commands (`addRowBefore`, `deleteColumn`, …) have existed
 * since tables were insertable, but had ZERO UI surface — they were
 * unreachable by anything but a raw command call. This popover, mounted by
 * the toolbar's table button (which only appears when the selection is
 * inside a table cell), exposes the row/column/table operations.
 *
 * Each item runs its command on the editor directly via
 * `editor.chain().focus()…run()`. Like the other toolbar selectors it uses
 * `onPointerDown` + `preventDefault` so the click never blurs the editor —
 * the cell selection the command operates on stays intact.
 */

import type { Editor } from '@tiptap/react'
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  type LucideIcon,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from './ui/button'
import { Separator } from './ui/separator'

export interface TableOpsSelectorProps {
  editor: Editor
  onClose: () => void
}

interface TableOp {
  id: string
  labelKey: string
  icon: LucideIcon
  run: (editor: Editor) => void
  /** Destructive ops are grouped below a separator and tinted. */
  destructive?: boolean
}

const TABLE_OPS: ReadonlyArray<TableOp> = [
  {
    id: 'insert-row-above',
    labelKey: 'toolbar.tableInsertRowAbove',
    icon: ArrowUpToLine,
    run: (e) => e.chain().focus().addRowBefore().run(),
  },
  {
    id: 'insert-row-below',
    labelKey: 'toolbar.tableInsertRowBelow',
    icon: ArrowDownToLine,
    run: (e) => e.chain().focus().addRowAfter().run(),
  },
  {
    id: 'insert-column-left',
    labelKey: 'toolbar.tableInsertColumnLeft',
    icon: ArrowLeftToLine,
    run: (e) => e.chain().focus().addColumnBefore().run(),
  },
  {
    id: 'insert-column-right',
    labelKey: 'toolbar.tableInsertColumnRight',
    icon: ArrowRightToLine,
    run: (e) => e.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'delete-row',
    labelKey: 'toolbar.tableDeleteRow',
    icon: Trash2,
    run: (e) => e.chain().focus().deleteRow().run(),
    destructive: true,
  },
  {
    id: 'delete-column',
    labelKey: 'toolbar.tableDeleteColumn',
    icon: Trash2,
    run: (e) => e.chain().focus().deleteColumn().run(),
    destructive: true,
  },
  {
    id: 'delete-table',
    labelKey: 'toolbar.tableDeleteTable',
    icon: Trash2,
    run: (e) => e.chain().focus().deleteTable().run(),
    destructive: true,
  },
]

export function TableOpsSelector({ editor, onClose }: TableOpsSelectorProps): React.ReactElement {
  const { t } = useTranslation()
  const firstDestructiveIndex = TABLE_OPS.findIndex((op) => op.destructive)

  return (
    <div className="flex flex-col gap-0.5" role="menu" aria-label={t('toolbar.tableOps')}>
      {TABLE_OPS.map((op, i) => {
        const Icon = op.icon
        return (
          <div key={op.id} className="contents">
            {i === firstDestructiveIndex && <Separator className="my-1" />}
            <Button
              variant="ghost"
              size="sm"
              role="menuitem"
              className={
                op.destructive
                  ? 'justify-start text-sm gap-2 text-destructive hover:text-destructive'
                  : 'justify-start text-sm gap-2'
              }
              data-testid={`table-op-${op.id}`}
              onPointerDown={(e) => {
                e.preventDefault()
                op.run(editor)
                onClose()
              }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(op.labelKey)}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
