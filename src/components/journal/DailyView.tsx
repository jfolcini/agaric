/**
 * DailyView — single day rendering with due/scheduled/done panels.
 */

import type React from 'react'
import { useMemo } from 'react'
import type { DayEntry } from '../../lib/date-utils'
import { getTodayString } from '../../lib/date-utils'
import { DaySection } from './DaySection'
import { UnfinishedTasks } from './UnfinishedTasks'

interface DailyViewProps {
  entry: DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
}

export function DailyView({
  entry,
  onNavigateToPage,
  onAddBlock,
}: DailyViewProps): React.ReactElement {
  const isToday = useMemo(() => entry.dateStr === getTodayString(), [entry.dateStr])

  return (
    <div key={entry.dateStr} className="space-y-4 animate-in fade-in-0 duration-150">
      {isToday && <UnfinishedTasks onNavigateToPage={onNavigateToPage} />}
      <DaySection
        entry={entry}
        headingLevel="h2"
        hideHeading
        mode="daily"
        onNavigateToPage={onNavigateToPage}
        onAddBlock={onAddBlock}
      />
    </div>
  )
}
