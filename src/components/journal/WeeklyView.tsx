/**
 * WeeklyView — 7-day grid rendering (Mon-Sun).
 */

import type React from 'react'
import { useMemo } from 'react'

import { DaySection } from '@/components/journal/DaySection'
import { RescheduleDropZone } from '@/components/journal/RescheduleDropZone'
import { useBatchCounts } from '@/hooks/useBatchCounts'
import { RescheduleDragSourceProvider } from '@/hooks/useRescheduleDragSource'
import type { DayEntry } from '@/lib/date-utils'
import { formatDate, getWeekDays } from '@/lib/date-utils'
import { useJournalStore } from '@/stores/journal'

interface WeeklyViewProps {
  makeDayEntry: (d: Date) => DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
}

export function WeeklyView({
  makeDayEntry,
  onNavigateToPage,
  onAddBlock,
}: WeeklyViewProps): React.ReactElement {
  const currentDate = useJournalStore((s) => s.currentDate)
  const todayStr = formatDate(new Date())

  const entries = useMemo(
    () => getWeekDays(currentDate).map(makeDayEntry),
    [currentDate, makeDayEntry],
  )

  const { agendaCountsBySource, backlinkCounts } = useBatchCounts(entries)

  return (
    // #2770 — WeeklyView's own per-day block rows are the ONLY reachable
    // source for the reschedule-by-drag gesture: `RescheduleDropZone` below
    // has accepted the `application/x-block-reschedule` payload since #2708,
    // but nothing in the shipped app ever SET that payload from a row a user
    // could actually reach (agenda's `BlockListItem` sets it, but agenda
    // panels are daily/agenda-mode-only and never co-render with this drop
    // zone). Wrapping the whole week in one provider opts every day's
    // `BlockTree` rows (via `SortableBlock`) into being native HTML5 drag
    // sources — see `useRescheduleDragSource.tsx` for why this rides a
    // context instead of a prop threaded through the BlockTree layers.
    <RescheduleDragSourceProvider>
      <div className="space-y-1">
        {entries.map((entry, i) => {
          const isToday = entry.dateStr === todayStr
          return (
            <RescheduleDropZone key={entry.dateStr} dateStr={entry.dateStr}>
              {i > 0 && <div className="border-t border-border my-4" />}
              <DaySection
                entry={entry}
                headingLevel={isToday ? 'h2' : 'h3'}
                compact
                mode="weekly"
                agendaCountsBySource={agendaCountsBySource}
                backlinkCounts={backlinkCounts}
                onNavigateToPage={onNavigateToPage}
                onAddBlock={onAddBlock}
                lazyMount
              />
            </RescheduleDropZone>
          )
        })}
      </div>
    </RescheduleDragSourceProvider>
  )
}
