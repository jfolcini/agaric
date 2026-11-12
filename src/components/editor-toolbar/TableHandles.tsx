/**
 * TableHandles — the controls on a table the caret is in (#6607), in block mode's
 * roving editor and page mode's document alike.
 *
 * - A handle on the caret's row (on the table's left edge) and one on its column (on
 *   the top edge). A press opens the row's or the column's operations
 *   (`TableOpsSelector`); a drag moves the row or column to where it is dropped. The
 *   header row has no move: a Markdown table's first row is its header.
 * - *Add row* under the last row and *Add column* after the last column.
 *
 * The controls are fixed-position over the editor, in a portal marked
 * `data-editor-portal`; a press never takes focus from the editor, so the caret the
 * operations act on stays put. React bubbles a portal's events to the block they are
 * rendered from, whose row starts a swipe or a block drag on touch, so they stop at
 * the portal. The keyboard path is the toolbar's Table menu, which lists the same
 * operations, and the move chords (`TableMoveKeys`).
 */

import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { GripHorizontal, GripVertical, Plus } from 'lucide-react'
import type React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { TableOpsSelector } from '@/components/TableOpsSelector'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  addTableColumnAtEnd,
  addTableRowAtEnd,
  moveTableColumnTo,
  moveTableRowTo,
  type TableCaret,
  tableCaret,
} from '@/editor/table-edit'

type Axis = 'row' | 'column'

/** A pointer travel shorter than this is a press, which opens the menu. */
const DRAG_THRESHOLD_PX = 6

/** The caret's table element: TipTap may wrap it in a `div`. */
function tableElement(editor: Editor, at: TableCaret): HTMLTableElement | null {
  if (editor.isDestroyed) return null
  const dom = editor.view.nodeDOM(at.tablePos)
  if (dom instanceof HTMLTableElement) return dom
  return dom instanceof HTMLElement ? dom.querySelector('table') : null
}

interface Layout {
  table: DOMRect
  row: DOMRect
  cell: DOMRect
}

function measure(editor: Editor, at: TableCaret): Layout | null {
  const table = tableElement(editor, at)
  const row = table?.rows[at.row]
  const cell = row?.cells[at.col]
  if (table == null || row === undefined || cell === undefined) return null
  return {
    table: table.getBoundingClientRect(),
    row: row.getBoundingClientRect(),
    cell: cell.getBoundingClientRect(),
  }
}

interface Drop {
  index: number
  /** The line the row or column would land on, in viewport pixels. */
  line: { left: number; top: number; width: number; height: number }
}

/**
 * Where a row or column dragged to (`x`, `y`) would land: the one whose box is nearest
 * along the drag's axis. Rows stay below the header.
 */
function dropAt(editor: Editor, at: TableCaret, axis: Axis, x: number, y: number): Drop | null {
  const table = tableElement(editor, at)
  if (table === null) return null
  const tableBox = table.getBoundingClientRect()
  const boxes =
    axis === 'row'
      ? Array.from(table.rows, (r) => r.getBoundingClientRect())
      : Array.from(table.rows[0]?.cells ?? [], (c) => c.getBoundingClientRect())
  const first = axis === 'row' ? 1 : 0
  let index = -1
  let best = Infinity
  for (let i = first; i < boxes.length; i++) {
    const box = boxes[i] as DOMRect
    const distance =
      axis === 'row'
        ? Math.abs(y - (box.top + box.height / 2))
        : Math.abs(x - (box.left + box.width / 2))
    if (distance < best) {
      best = distance
      index = i
    }
  }
  if (index === -1) return null
  const box = boxes[index] as DOMRect
  const from = axis === 'row' ? at.row : at.col
  const after = index > from
  return {
    index,
    line:
      axis === 'row'
        ? {
            left: tableBox.left,
            top: after ? box.bottom : box.top,
            width: tableBox.width,
            height: 0,
          }
        : {
            left: after ? box.right : box.left,
            top: tableBox.top,
            width: 0,
            height: tableBox.height,
          },
  }
}

/** Each control is centred on the point its style gives. */
const PLACED = 'fixed z-40 -translate-x-1/2 -translate-y-1/2'

/** Stops a portal's events at the portal, before the block row they would reach. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation()
const STOPPED = {
  onPointerDown: stop,
  onMouseDown: stop,
  onTouchStart: stop,
  onTouchMove: stop,
  onTouchEnd: stop,
  onContextMenu: stop,
  onKeyDown: stop,
  onClick: stop,
}

export function TableHandles({ editor }: { editor: Editor }): React.ReactElement | null {
  const { t } = useTranslation()
  const at = useEditorState({
    editor,
    selector: (ctx) =>
      ctx.editor.isEditable && ctx.editor.isFocused ? tableCaret(ctx.editor.state) : null,
  })
  const [layout, setLayout] = useState<Layout | null>(null)
  // The cell the menu was opened on: the caret leaving it closes the menu.
  const [menu, setMenu] = useState<{ axis: Axis; row: number; col: number } | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const press = useRef<{ axis: Axis; x: number; y: number; dragging: boolean } | null>(null)

  useLayoutEffect(() => {
    if (at === null) return
    const update = () => setLayout(measure(editor, at))
    update()
    editor.on('update', update)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      editor.off('update', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [editor, at])

  if (at === null || layout === null) return null

  const openAxis = menu !== null && menu.row === at.row && menu.col === at.col ? menu.axis : null
  const toggle = (axis: Axis) =>
    setMenu(openAxis === axis ? null : { axis, row: at.row, col: at.col })
  const move = (axis: Axis, to: number) =>
    axis === 'row' ? moveTableRowTo(editor, to) : moveTableColumnTo(editor, to)

  const handleEvents = (axis: Axis): Partial<React.ComponentProps<'button'>> => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      press.current = { axis, x: e.clientX, y: e.clientY, dragging: false }
    },
    onPointerMove: (e) => {
      const p = press.current
      if (p === null) return
      if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return
      p.dragging = true
      // The header row never moves (`moveTableRowTo`), so it shows nowhere to land.
      setDrop(
        axis === 'row' && at.row === 0 ? null : dropAt(editor, at, axis, e.clientX, e.clientY),
      )
    },
    onPointerUp: (e) => {
      const p = press.current
      press.current = null
      setDrop(null)
      if (p === null) return
      if (!p.dragging) {
        toggle(axis)
        return
      }
      const target = dropAt(editor, at, axis, e.clientX, e.clientY)
      if (target !== null) move(axis, target.index)
    },
    onPointerCancel: () => {
      press.current = null
      setDrop(null)
    },
    // Enter or Space on a focused handle.
    onClick: (e) => {
      if (e.detail === 0) toggle(axis)
    },
  })

  const handle = (axis: Axis, style: React.CSSProperties) => {
    const label = t(axis === 'row' ? 'toolbar.tableRowActions' : 'toolbar.tableColumnActions')
    const open = openAxis === axis
    return (
      <Popover open={open} onOpenChange={(next) => next || setMenu(null)}>
        <PopoverAnchor className={PLACED} style={style}>
          <IconButton
            variant="outline"
            size="icon-xs"
            className="touch-none bg-background"
            tooltip={t(
              axis === 'row' ? 'toolbar.tableRowHandleTip' : 'toolbar.tableColumnHandleTip',
            )}
            ariaLabel={label}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid={`table-${axis}-handle`}
            data-table-handle
            {...handleEvents(axis)}
          >
            {axis === 'row' ? <GripVertical /> : <GripHorizontal />}
          </IconButton>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] p-1"
          data-editor-portal
          // The operations act on the caret's cell: focus stays in the text.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A press on a handle is the handle's: it toggles this menu or opens the other.
          onInteractOutside={(e) => {
            if (e.target instanceof Element && e.target.closest('[data-table-handle]')) {
              e.preventDefault()
            }
          }}
        >
          <TableOpsSelector editor={editor} scope={axis} onClose={() => setMenu(null)} />
        </PopoverContent>
      </Popover>
    )
  }

  const { table, row, cell } = layout
  const addButton = (kind: 'row' | 'column', style: React.CSSProperties) => (
    <div className={PLACED} style={style}>
      <IconButton
        variant="outline"
        size="icon-xs"
        className="bg-background"
        tooltip={t(kind === 'row' ? 'toolbar.tableAddRow' : 'toolbar.tableAddColumn')}
        ariaLabel={t(kind === 'row' ? 'toolbar.tableAddRow' : 'toolbar.tableAddColumn')}
        data-testid={`table-add-${kind}`}
        {...toolbarPressHandlers(() =>
          kind === 'row' ? addTableRowAtEnd(editor) : addTableColumnAtEnd(editor),
        )}
      >
        <Plus />
      </IconButton>
    </div>
  )

  return createPortal(
    <div data-editor-portal data-testid="table-handles" {...STOPPED}>
      {handle('row', { left: table.left, top: row.top + row.height / 2 })}
      {handle('column', { left: cell.left + cell.width / 2, top: table.top })}
      {addButton('row', { left: table.left + table.width / 2, top: table.bottom })}
      {addButton('column', { left: table.right, top: table.top + table.height / 2 })}
      {drop !== null && (
        <div
          aria-hidden
          data-testid="table-drop-line"
          className="pointer-events-none fixed z-40 border-2 border-primary"
          style={drop.line}
        />
      )}
    </div>,
    document.body,
  )
}
