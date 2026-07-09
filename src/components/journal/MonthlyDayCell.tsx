/**
 * MonthlyDayCell — compact day cell for the monthly calendar grid.
 * Shows date number, colored count dots, and handles click-to-navigate.
 */

import { format } from 'date-fns'
import type React from 'react'

import { getSourceColor } from '@/lib/date-property-colors'
import type { DayEntry } from '@/lib/date-utils'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface MonthlyDayCellProps {
  entry: DayEntry
  isToday: boolean
  isCurrentMonth: boolean
  agendaCount: number
  agendaCountsBySource?: Record<string, number>
  backlinkCount: number
  onNavigateToDate: (dateStr: string) => void
  /**
   * Roving tabindex (#2057): MonthlyView drives a single tab stop across the
   * grid. When provided, this overrides the default ("0 for the current month,
   * -1 for adjacent") so only the one roving cell is tabbable. Adjacent-month
   * cells are inert and always stay -1.
   */
  tabIndex?: number
  /** Notify the grid which cell took focus so it can track the roving origin. */
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void
  /** Roving-focus target ref (React 19 ref-as-prop), set by MonthlyView. */
  ref?: React.Ref<HTMLDivElement>
}

export function MonthlyDayCell({
  entry,
  isToday,
  isCurrentMonth,
  agendaCount,
  agendaCountsBySource,
  backlinkCount,
  onNavigateToDate,
  tabIndex,
  onFocus,
  ref,
}: MonthlyDayCellProps): React.ReactElement {
  const dayNumber = entry.date.getDate()
  const totalCount = agendaCount + backlinkCount
  const fullDate = format(entry.date, 'EEEE, MMMM d, yyyy')

  // #1730: the decorative dots and total-count badge are aria-hidden, and the
  // explicit aria-label below overrides any inner text, so a screen-reader user
  // gets no indication of a day's density. Surface the counts in the label.
  const countParts: string[] = []
  if (agendaCount > 0) {
    countParts.push(t('journal.dayCellAgendaCount', { count: agendaCount }))
  }
  if (backlinkCount > 0) {
    countParts.push(t('journal.dayCellBacklinkCount', { count: backlinkCount }))
  }
  const countLabel = countParts.join(', ')
  const ariaLabel = countLabel ? `${fullDate}, ${countLabel}` : fullDate

  const handleClick = () => {
    if (isCurrentMonth) onNavigateToDate(entry.dateStr)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && isCurrentMonth) {
      e.preventDefault()
      onNavigateToDate(entry.dateStr)
    }
  }

  // Roving tabindex (#2057): the grid passes an explicit `tabIndex` so exactly
  // one in-month cell is a tab stop. Adjacent-month cells are inert (never a
  // tab stop). When no `tabIndex` is supplied (e.g. a standalone render) fall
  // back to the historical "0 for current month, -1 for adjacent" behaviour.
  const resolvedTabIndex = !isCurrentMonth ? -1 : (tabIndex ?? 0)

  return (
    <div
      ref={ref}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA grid cell on a CSS-grid div; a real <td> requires <table>/<tr> ancestry that would break the calendar grid layout
      role="gridcell"
      aria-label={ariaLabel}
      tabIndex={resolvedTabIndex}
      data-date={entry.dateStr}
      className={cn(
        'relative bg-background p-1.5 min-h-[80px] [@media(pointer:coarse)]:min-h-[44px] transition-colors focus-ring-visible',
        isCurrentMonth && 'cursor-pointer hover:bg-accent/30 active:bg-accent/50',
        !isCurrentMonth && 'opacity-40 pointer-events-none',
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
    >
      {/* Date number */}
      <span
        className={cn(
          'inline-flex items-center justify-center text-sm font-medium w-7 h-7 rounded-full [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11',
          isToday && 'bg-primary text-primary-foreground font-bold',
        )}
      >
        {dayNumber}
      </span>

      {/* Count dots — use the -foreground color tokens for WCAG contrast
          against the cell background in both light and dark modes. */}
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
