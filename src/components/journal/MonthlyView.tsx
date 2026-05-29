/**
 * MonthlyView — 7-column CSS Grid calendar for the entire month (UX-83).
 *
 * Replaces the old vertical DaySection list with a compact calendar grid.
 * Each cell is a MonthlyDayCell showing date number, colored count dots,
 * and click-to-navigate.
 */

import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useBatchCounts } from '../../hooks/useBatchCounts'
import { useWeekStart } from '../../hooks/useWeekStart'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate } from '../../lib/date-utils'
import { useJournalStore } from '../../stores/journal'
import { MonthlyDayCell } from './MonthlyDayCell'

interface MonthlyViewProps {
  makeDayEntry: (d: Date) => DayEntry
}

export function MonthlyView({ makeDayEntry }: MonthlyViewProps): React.ReactElement {
  const { t } = useTranslation()
  const currentDate = useJournalStore((s) => s.currentDate)
  const navigateToDate = useJournalStore((s) => s.navigateToDate)
  const { weekStartsOn } = useWeekStart()
  const todayStr = formatDate(new Date())

  // Compute all days to display, including padding days from adjacent months
  const entries = useMemo(() => {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    const gridStart = startOfWeek(monthStart, { weekStartsOn })
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn })
    return eachDayOfInterval({ start: gridStart, end: gridEnd }).map(makeDayEntry)
  }, [currentDate, makeDayEntry, weekStartsOn])

  const { agendaCounts, agendaCountsBySource, backlinkCounts } = useBatchCounts(entries)

  // Build day-of-week headers based on weekStartsOn
  const dayHeaders = useMemo(() => {
    const headers: string[] = []
    const refDate = startOfWeek(new Date(), { weekStartsOn })
    for (let i = 0; i < 7; i++) {
      headers.push(format(addDays(refDate, i), 'EEE'))
    }
    return headers
  }, [weekStartsOn])

  // Split entries into weeks (rows of 7)
  const weeks = useMemo(() => {
    const result: DayEntry[][] = []
    for (let i = 0; i < entries.length; i += 7) {
      result.push(entries.slice(i, i + 7))
    }
    return result
  }, [entries])

  const handleNavigateToDate = (dateStr: string) => {
    const parts = dateStr.split('-')
    if (parts.length === 3) {
      const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
      navigateToDate(date, 'daily')
    }
  }

  return (
    <div
      role="grid"
      aria-label={t('journal.monthlyCalendarLabel')}
      className="rounded-lg overflow-hidden bg-border"
    >
      {/* Day-of-week headers */}
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- header row is not interactive */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA grid built on CSS grid divs; a real <tr> requires <table>/<tbody> ancestry that would break the grid-cols-7 layout */}
      <div role="row" className="grid grid-cols-7 gap-0.5">
        {dayHeaders.map((header) => (
          // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- header cells are not interactive
          <div
            key={header}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA grid cell on a CSS-grid div; a real <th> requires <table>/<tr> ancestry that would break the grid layout
            role="columnheader"
            className="bg-background py-1.5 text-center text-xs font-medium text-muted-foreground"
          >
            {header}
          </div>
        ))}
      </div>

      {/* Calendar grid rows */}
      {weeks.map((week) => {
        const weekKey = week[0]?.dateStr ?? ''
        return (
          // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- cells within handle focus
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA grid row on a CSS-grid div; a real <tr> requires <table>/<tbody> ancestry that would break the grid-cols-7 layout
          <div key={weekKey} role="row" className="grid grid-cols-7 gap-0.5">
            {week.map((entry) => {
              const isToday = entry.dateStr === todayStr
              const isCurrentMonth = isSameMonth(entry.date, currentDate)
              const agendaCount = agendaCounts[entry.dateStr] ?? 0
              const entryAgendaBySource = agendaCountsBySource[entry.dateStr]
              const backlinkCount = entry.pageId ? (backlinkCounts[entry.pageId] ?? 0) : 0

              return (
                <MonthlyDayCell
                  key={entry.dateStr}
                  entry={entry}
                  isToday={isToday}
                  isCurrentMonth={isCurrentMonth}
                  agendaCount={agendaCount}
                  {...(entryAgendaBySource != null && {
                    agendaCountsBySource: entryAgendaBySource,
                  })}
                  backlinkCount={backlinkCount}
                  onNavigateToDate={handleNavigateToDate}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
