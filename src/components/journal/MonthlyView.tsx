/**
 * MonthlyView — 7-column CSS Grid calendar for the entire month.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

  // #2057: roving tabindex over the calendar grid. The grid declares
  // role="grid", which promises arrow-key roving focus — but every in-month
  // cell used to be a tab stop with only Enter/Space, so the advertised arrows
  // did nothing and keyboard users tabbed through 30+ cells. We now keep a
  // single tab stop (`focusedDate`) and move it with Arrow / Home / End, while
  // adjacent-month cells stay inert (never focusable).
  //
  // `focusedDate` is the dateStr of the in-month cell that owns the tab stop.
  // It seeds on today when today is in-month, else the first in-month day.
  const inMonthDates = useMemo(
    () => entries.filter((e) => isSameMonth(e.date, currentDate)).map((e) => e.dateStr),
    [entries, currentDate],
  )
  const defaultFocusedDate = inMonthDates.includes(todayStr) ? todayStr : (inMonthDates[0] ?? null)
  const [focusedDate, setFocusedDate] = useState<string | null>(defaultFocusedDate)

  // Reset the roving tab stop when the displayed month changes (the previous
  // focused date is no longer in this grid). Keyed on the in-month set so it
  // re-seeds exactly once per month change.
  useEffect(() => {
    setFocusedDate((prev) =>
      prev !== null && inMonthDates.includes(prev) ? prev : defaultFocusedDate,
    )
  }, [inMonthDates, defaultFocusedDate])

  // dateStr → its index in the flat `entries` array (includes padding cells),
  // so arrow math can step by ±1 (horizontal) and ±7 (vertical) across the grid.
  const indexByDate = useMemo(() => {
    const map = new Map<string, number>()
    entries.forEach((e, i) => map.set(e.dateStr, i))
    return map
  }, [entries])

  const cellRefs = useRef(new Map<string, HTMLDivElement>())
  const registerCell = useCallback((dateStr: string, node: HTMLDivElement | null) => {
    if (node) cellRefs.current.set(dateStr, node)
    else cellRefs.current.delete(dateStr)
  }, [])

  // Move the roving tab stop to a flat-array index, skipping over any
  // out-of-month (inert) cells in the requested direction. Returns silently if
  // the move would leave the grid or no in-month cell is reachable.
  const moveFocusTo = useCallback(
    (targetIndex: number, step: number) => {
      let i = targetIndex
      while (i >= 0 && i < entries.length) {
        const entry = entries[i]
        if (entry && isSameMonth(entry.date, currentDate)) {
          setFocusedDate(entry.dateStr)
          cellRefs.current.get(entry.dateStr)?.focus()
          return
        }
        // The requested cell is padding (adjacent month) — keep stepping in the
        // same direction so an arrow press still lands on a real day.
        i += step
      }
    },
    [entries, currentDate],
  )

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (focusedDate === null) return
      const cur = indexByDate.get(focusedDate)
      if (cur === undefined) return
      let target: number | null = null
      let step = 1
      switch (e.key) {
        case 'ArrowRight': {
          target = cur + 1
          step = 1
          break
        }
        case 'ArrowLeft': {
          target = cur - 1
          step = -1
          break
        }
        case 'ArrowDown': {
          target = cur + 7
          step = 7
          break
        }
        case 'ArrowUp': {
          target = cur - 7
          step = -7
          break
        }
        case 'Home': {
          // First cell of the current week row.
          target = cur - (cur % 7)
          step = 1
          break
        }
        case 'End': {
          // Last cell of the current week row.
          target = cur - (cur % 7) + 6
          step = -1
          break
        }
        default: {
          return
        }
      }
      e.preventDefault()
      moveFocusTo(target, step)
    },
    [focusedDate, indexByDate, moveFocusTo],
  )

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
      // Programmatically focusable (not a tab stop) so the grid can host the
      // arrow-key handler; the roving cell keeps the single tabindex 0.
      tabIndex={-1}
      onKeyDown={handleGridKeyDown}
    >
      {/* Day-of-week headers */}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA grid built on CSS grid divs; a real <tr> requires <table>/<tbody> ancestry that would break the grid-cols-7 layout */}
      <div role="row" className="grid grid-cols-7 gap-0.5">
        {dayHeaders.map((header) => (
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
                  ref={(node) => registerCell(entry.dateStr, node)}
                  entry={entry}
                  isToday={isToday}
                  isCurrentMonth={isCurrentMonth}
                  agendaCount={agendaCount}
                  {...(entryAgendaBySource != null && {
                    agendaCountsBySource: entryAgendaBySource,
                  })}
                  backlinkCount={backlinkCount}
                  onNavigateToDate={handleNavigateToDate}
                  tabIndex={isCurrentMonth && entry.dateStr === focusedDate ? 0 : -1}
                  onFocus={() => setFocusedDate(entry.dateStr)}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
