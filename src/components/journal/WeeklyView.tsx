/**
 * WeeklyView — 7-day grid rendering (Mon-Sun).
 */

import type React from 'react'
import { useMemo } from 'react'
import { useBatchCounts } from '../../hooks/useBatchCounts'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate, getWeekDays } from '../../lib/date-utils'
import { useJournalStore } from '../../stores/journal'
import { DaySection } from './DaySection'

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
  const { currentDate } = useJournalStore()
  const todayStr = formatDate(new Date())

  const entries = useMemo(
    () => getWeekDays(currentDate).map(makeDayEntry),
    [currentDate, makeDayEntry],
  )

  const { agendaCounts, backlinkCounts } = useBatchCounts(entries)

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => {
        const isToday = entry.dateStr === todayStr
        return (
          <div key={entry.dateStr}>
            {i > 0 && <div className="border-t border-border my-4" />}
            <DaySection
              entry={entry}
              headingLevel={isToday ? 'h2' : 'h3'}
              compact
              mode="weekly"
              agendaCounts={agendaCounts}
              backlinkCounts={backlinkCounts}
              onNavigateToPage={onNavigateToPage}
              onAddBlock={onAddBlock}
            />
          </div>
        )
      })}
    </div>
  )
}
