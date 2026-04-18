/**
 * MonthlyDayCell — compact day cell for the monthly calendar grid (UX-83).
 * Shows date number, colored count dots, and handles click-to-navigate.
 */

import { format } from 'date-fns'
import type React from 'react'
import { cn } from '@/lib/utils'
import { getSourceColor } from '../../lib/date-property-colors'
import type { DayEntry } from '../../lib/date-utils'

interface MonthlyDayCellProps {
  entry: DayEntry
  isToday: boolean
  isCurrentMonth: boolean
  agendaCount: number
  agendaCountsBySource?: Record<string, number>
  backlinkCount: number
  onNavigateToDate: (dateStr: string) => void
}

export function MonthlyDayCell({
  entry,
  isToday,
  isCurrentMonth,
  agendaCount,
  agendaCountsBySource,
  backlinkCount,
  onNavigateToDate,
}: MonthlyDayCellProps): React.ReactElement {
  const dayNumber = entry.date.getDate()
  const totalCount = agendaCount + backlinkCount
  const fullDate = format(entry.date, 'EEEE, MMMM d, yyyy')

  const handleClick = () => {
    if (isCurrentMonth) onNavigateToDate(entry.dateStr)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && isCurrentMonth) {
      e.preventDefault()
      onNavigateToDate(entry.dateStr)
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA gridcell within calendar grid pattern
    <div
      role="gridcell"
      aria-label={fullDate}
      tabIndex={isCurrentMonth ? 0 : -1}
      className={cn(
        'relative bg-background p-1.5 min-h-[80px] [@media(pointer:coarse)]:min-h-[44px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        isCurrentMonth && 'cursor-pointer hover:bg-accent/30 active:bg-accent/50',
        !isCurrentMonth && 'opacity-40 pointer-events-none',
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Date number */}
      <span
        className={cn(
          'inline-flex items-center justify-center text-sm font-medium w-7 h-7 rounded-full',
          isToday && 'bg-primary text-primary-foreground font-bold',
        )}
      >
        {dayNumber}
      </span>

      {/* Count dots — use the -foreground color tokens for WCAG contrast
          against the cell background in both light and dark modes (UX-199). */}
      {totalCount > 0 && (
        <div className="flex flex-wrap gap-0.5 mt-1">
          {agendaCountsBySource &&
            Object.entries(agendaCountsBySource).map(([source, count]) => {
              if (count <= 0) return null
              const color = getSourceColor(source)
              // Derive a bg-* class from the high-contrast text-*-foreground
              // class (e.g. "text-date-due-foreground" → "bg-date-due-foreground").
              // The foreground tokens are designed for readable text on the pill
              // background, which gives us L~0.39-0.48 in light mode and L~0.80-0.84
              // in dark mode — both meet WCAG 3:1 contrast on cell bg.
              const textClass = color.light.split(' ').find((c) => c.startsWith('text-'))
              const bgClass = textClass
                ? textClass.replace(/^text-/, 'bg-')
                : (color.light.split(' ').find((c) => c.startsWith('bg-')) ?? 'bg-muted-foreground')
              return (
                <span
                  key={source}
                  className={cn('w-1.5 h-1.5 rounded-full', bgClass)}
                  aria-hidden="true"
                />
              )
            })}
          {backlinkCount > 0 && (
            // Full opacity muted-foreground so backlink dots are visible in both modes.
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
          )}
        </div>
      )}

      {/* Total count badge */}
      {totalCount > 0 && (
        <span className="absolute bottom-1 right-1.5 text-xs [@media(pointer:coarse)]:text-sm text-muted-foreground">
          {totalCount}
        </span>
      )}
    </div>
  )
}
