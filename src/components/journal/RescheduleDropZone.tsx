/**
 * RescheduleDropZone — native HTML5 drop target for rescheduling tasks (F-32).
 *
 * Wraps a DaySection in weekly/monthly views. Accepts blocks dragged
 * via native drag with 'application/x-block-reschedule' data type.
 * On drop, calls setDueDate to reschedule the task to this day.
 *
 * Coexists with dnd-kit (which handles same-page block reordering) because
 * this uses native HTML5 drag/drop events, not dnd-kit's pointer system.
 *
 * ## Keyboard accessibility (UX-274)
 *
 * Drag-and-drop is intentionally pointer-only — keyboard users do **not**
 * need to interact with this drop zone. The keyboard-equivalent path for
 * rescheduling a task lives on the date chip itself:
 *
 *   1. Tab / arrow-navigate to the task's due-date chip
 *      (`DateChip` → opens a Popover containing `DateChipEditor`).
 *   2. The popover exposes:
 *        - A natural-language `Input` (`today`, `+3d`, `Apr 15`, …)
 *        - Quick-action `Button`s (Today, Tomorrow, Next Week, Clear)
 *      All controls are reachable with Tab / Enter / Space.
 *   3. Pressing Enter on the input or activating any quick action calls
 *      `setDueDate` / `setScheduledDate` — the same backend command this
 *      drop zone calls — and triggers a screen-reader announcement.
 *
 * The `biome-ignore` for `noStaticElementInteractions` below is therefore
 * justified: the static `<div>` is a passive HTML5 drop surface, and the
 * accessible reschedule path is fully covered by `DateChipEditor`.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { announce } from '@/lib/announcer'
import { logger } from '@/lib/logger'
import { reportIpcError } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'
import { useBlockReschedule } from '../../hooks/useBlockReschedule'
import { getBlock } from '../../lib/tauri'

interface RescheduleDropZoneProps {
  dateStr: string
  children: React.ReactNode
  className?: string | undefined
}

/** Custom MIME type used to identify reschedule drag operations. */
export const RESCHEDULE_DRAG_TYPE = 'application/x-block-reschedule'

export function RescheduleDropZone({
  dateStr,
  children,
  className,
}: RescheduleDropZoneProps): React.ReactElement {
  const { t } = useTranslation()
  const [isOver, setIsOver] = useState(false)
  const { setDueDate, setScheduledDate } = useBlockReschedule()

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(RESCHEDULE_DRAG_TYPE)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setIsOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear highlight when leaving the container entirely (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsOver(false)
      const blockId = e.dataTransfer.getData(RESCHEDULE_DRAG_TYPE)
      if (!blockId) return
      try {
        let useScheduledDate = false
        try {
          const block = await getBlock(blockId)
          if (block.scheduled_date && !block.due_date) {
            useScheduledDate = true
          }
        } catch (err) {
          logger.warn(
            'RescheduleDropZone',
            'Failed to fetch block, falling back to setDueDate',
            { blockId },
            err,
          )
        }

        if (useScheduledDate) {
          await setScheduledDate(blockId, dateStr)
        } else {
          await setDueDate(blockId, dateStr)
        }
        toast.success(t('journal.rescheduled', { date: dateStr }))
        announce(t('announce.taskRescheduled', { date: dateStr }))
      } catch (err) {
        reportIpcError('RescheduleDropZone', 'journal.rescheduleFailed', err, t, {
          blockId,
          dateStr,
        })
        announce(t('announce.rescheduleFailed'))
      }
    },
    [dateStr, setDueDate, setScheduledDate, t],
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: passive HTML5 drop target — drag events are not keyboard-interactive
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid={`reschedule-drop-zone-${dateStr}`}
      className={cn(
        'transition-colors rounded-lg',
        isOver && 'ring-2 ring-primary bg-primary/5',
        className,
      )}
    >
      {children}
    </div>
  )
}
