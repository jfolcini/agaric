/**
 * DailyView — single day rendering with due/scheduled/done panels.
 */

import type React from 'react'
import type { DayEntry } from '../../lib/date-utils'
import { DaySection } from './DaySection'

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
  return (
    <div key={entry.dateStr} className="space-y-4 animate-in fade-in-0 duration-150">
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
