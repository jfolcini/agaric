/**
 * BlockTablePicker — the `/table` slash command's size grid: the toolbar's
 * `TablePicker` in a Radix Popover anchored at the caret, starting on 3×3 so
 * `/table` then Enter inserts a 3×3 table.
 *
 * `data-editor-portal` keeps the roving editor mounted while focus sits in the
 * grid (`useEditorBlur`); without it the blur unmounts the editor and the
 * insert has no block to land in.
 */

import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TablePicker } from '@/components/editor-toolbar/TablePicker'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export function BlockTablePicker({
  editor,
  onClose,
}: {
  editor: Editor
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  // Stable: Radix re-anchors whenever this ref's object changes.
  const caret = useRef({
    getBoundingClientRect: () => {
      if (editor.isDestroyed) return new DOMRect()
      const c = editor.view.coordsAtPos(editor.state.selection.from)
      return new DOMRect(c.left, c.top, 0, c.bottom - c.top)
    },
  })

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <PopoverAnchor virtualRef={caret} />
      <PopoverContent
        align="start"
        className="w-auto p-1"
        aria-label={t('toolbar.insertTable')}
        data-editor-portal
        // There is no trigger to hand focus back to, so it goes to the editor.
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          if (!editor.isDestroyed) editor.commands.focus()
        }}
      >
        <TablePicker editor={editor} onClose={onClose} initialRows={3} initialCols={3} />
      </PopoverContent>
    </Popover>
  )
}
