/**
 * RescheduleDropZone — native HTML5 drop target for rescheduling tasks (F-32).
 *
 * Wraps a DaySection in weekly/monthly views. Accepts blocks dragged
 * via native drag with 'application/x-block-reschedule' data type.
 * On drop, calls setDueDate to reschedule the task to this day.
 *
 * Coexists with dnd-kit (which handles same-page block reordering) because
 * this uses native HTML5 drag/drop events, not dnd-kit's pointer system.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { setDueDate } from '../../lib/tauri'

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
        await setDueDate(blockId, dateStr)
        toast.success(t('journal.rescheduled', { date: dateStr }))
      } catch {
        toast.error(t('journal.rescheduleFailed'))
      }
    },
    [dateStr, t],
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
