/**
 * TablePicker — toolbar grid picker for inserting an N×M table (#215b).
 *
 * Today a table is only insertable via the `/table` slash command. This popover
 * surfaces the familiar Google-Docs / Notion grid: hovering (or arrow-keying)
 * over the grid highlights an R×C selection; clicking (or pressing Enter)
 * inserts that table. It inserts through the SAME path the slash command uses
 * (`editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true })`)
 * so behaviour — header-row default included — is identical.
 *
 * UI-only: no persistence, IPC, or schema change. Like the other toolbar
 * selectors it uses `onPointerDown` + `preventDefault` so the click never blurs
 * the editor.
 */

import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Max dimensions offered by the grid. Matches common doc editors (Notion 10×10). */
const MAX_ROWS = 8
const MAX_COLS = 8

export interface TablePickerProps {
  editor: Editor
  onClose: () => void
}

export function TablePicker({ editor, onClose }: TablePickerProps): React.ReactElement {
  const { t } = useTranslation()
  // 1-based hovered/selected dimensions; 0 means nothing highlighted yet.
  const [rows, setRows] = useState(0)
  const [cols, setCols] = useState(0)

  const insert = (r: number, c: number) => {
    // Same insert path as the `/table` slash command (header-row default).
    editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: true }).run()
    onClose()
  }

  // Roving keyboard navigation over the grid: arrows move the highlight,
  // Enter/Space inserts the current selection. Falls back to 1×1 when nothing
  // is highlighted yet so the first arrow key has a sensible origin.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const r = rows || 1
    const c = cols || 1
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        setRows(Math.min(MAX_ROWS, r + 1))
        setCols(c)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setRows(Math.max(1, r - 1))
        setCols(c)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        setCols(Math.min(MAX_COLS, c + 1))
        setRows(r)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        setCols(Math.max(1, c - 1))
        setRows(r)
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        insert(r, c)
        break
      }
      default: {
        break
      }
    }
  }

  const label = rows > 0 && cols > 0 ? `${rows} × ${cols}` : t('toolbar.tableInsertHint')

  return (
    <div className="flex flex-col gap-2" data-testid="table-picker">
      {/*
        The grid is a focusable composite widget driven by arrow keys +
        Enter (roving selection); each cell is a button so pointer users get
        hover-highlight + click-to-insert. aria-label announces the picker;
        the live dimension label below echoes the current selection.
      */}
      <div
        className="flex flex-col gap-0.5 p-1 focus-outline rounded"
        tabIndex={0}
        role="grid"
        aria-label={t('toolbar.insertTable')}
        onKeyDown={handleKeyDown}
      >
        {Array.from({ length: MAX_ROWS }, (_, ri) => {
          const r = ri + 1
          return (
            <div
              key={r}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="row" on a flex <div> inside the role="grid" dimension picker; a native <tr> can't host the flexbox row of cell <button>s
              role="row"
              className="flex gap-0.5"
            >
              {Array.from({ length: MAX_COLS }, (_, ci) => {
                const c = ci + 1
                const active = r <= rows && c <= cols
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="gridcell" on the clickable cell <button> inside the role="grid"/role="row" picker
                    role="gridcell"
                    aria-label={t('toolbar.tableDimensionsCell', { rows: r, cols: c })}
                    aria-selected={active}
                    data-testid={`table-cell-${r}-${c}`}
                    className={
                      active
                        ? 'h-5 w-5 rounded-sm border border-primary bg-primary/30'
                        : 'h-5 w-5 rounded-sm border border-border bg-muted/30'
                    }
                    onPointerEnter={() => {
                      setRows(r)
                      setCols(c)
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      insert(r, c)
                    }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
      <p className="text-center text-xs text-muted-foreground" data-testid="table-picker-label">
        {label}
      </p>
    </div>
  )
}
