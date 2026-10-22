/**
 * DailyView — single day rendering with due/scheduled/done panels.
 */

import type React from 'react'
import { useState } from 'react'

import { DaySection } from '@/components/journal/DaySection'
import { UnfinishedTasks } from '@/components/journal/UnfinishedTasks'
import { useToday } from '@/hooks/useToday'
import type { DayEntry } from '@/lib/date-utils'
import { cn } from '@/lib/utils'

interface DailyViewProps {
  entry: DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
  onPageDeleted?: ((dateStr: string) => void) | undefined
}

export function DailyView({
  entry,
  onNavigateToPage,
  onAddBlock,
  onPageDeleted,
}: DailyViewProps): React.ReactElement {
  const isToday = entry.dateStr === useToday()
  // The day the view mounts with replaces the loading skeleton and paints at
  // once, so boot does not ramp the journal up from transparent (#5440).
  // Every day navigated to after that fades in.
  const [mountDay, setMountDay] = useState<string | null>(entry.dateStr)
  if (mountDay !== null && entry.dateStr !== mountDay) setMountDay(null)

  return (
    <div
      key={entry.dateStr}
      className={cn('space-y-4', mountDay === null && 'animate-in fade-in-0 duration-normal')}
    >
      {isToday && <UnfinishedTasks onNavigateToPage={onNavigateToPage} />}
      <DaySection
        entry={entry}
        headingLevel="h2"
        hideHeading
        mode="daily"
        onNavigateToPage={onNavigateToPage}
        onAddBlock={onAddBlock}
        onPageDeleted={onPageDeleted}
      />
    </div>
  )
}
