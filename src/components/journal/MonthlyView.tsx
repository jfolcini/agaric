/**
 * MonthlyView — calendar grid rendering for the entire month.
 */

import { eachDayOfInterval, endOfMonth, startOfMonth } from 'date-fns'
import type React from 'react'
import { useMemo } from 'react'
import { useBatchCounts } from '../../hooks/useBatchCounts'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate } from '../../lib/date-utils'
import { useJournalStore } from '../../stores/journal'
import { DaySection } from './DaySection'

interface MonthlyViewProps {
  makeDayEntry: (d: Date) => DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
}

export function MonthlyView({
  makeDayEntry,
  onNavigateToPage,
  onAddBlock,
}: MonthlyViewProps): React.ReactElement {
  const { currentDate } = useJournalStore()
  const todayStr = formatDate(new Date())

  const entries = useMemo(() => {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    return eachDayOfInterval({ start: monthStart, end: monthEnd }).map(makeDayEntry)
  }, [currentDate, makeDayEntry])

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
              mode="monthly"
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
