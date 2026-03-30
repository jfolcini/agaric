/**
 * JournalPage — daily/weekly/monthly journal view backed by BlockTree.
 *
 * Three viewing modes:
 * - **Daily** (default): One day with prev/next navigation and today button.
 * - **Weekly**: Mon-Sun of one week, each day as a section with BlockTree.
 * - **Monthly**: Calendar grid showing content indicators; click to go to daily.
 *
 * A floating calendar date picker (react-day-picker inside Radix Popover)
 * lets the user jump to any date. Days with content are highlighted.
 */

import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plus,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { createBlock, listBlocks } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { BlockTree } from './BlockTree'

// ── Types ─────────────────────────────────────────────────────────────

type JournalMode = 'daily' | 'weekly' | 'monthly'

interface DayEntry {
  date: Date
  dateStr: string
  displayDate: string
  pageId: string | null
}

interface JournalPageProps {
  /** Called when a block is clicked — navigates to block editor. */
  onBlockClick?: (blockId: string) => void
  /** Called to navigate to a page for editing. */
  onNavigateToPage?: (pageId: string, title?: string) => void
}

// ── Helpers ───────────────────────────────────────────────────────────

const WEEK_OPTIONS = { weekStartsOn: 1 as const }

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Format a Date as a readable string (e.g., "Mon, Jan 15 2025"). */
function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Get the Monday-start week range for a given date. */
function getWeekRange(d: Date): { start: Date; end: Date } {
  return {
    start: startOfWeek(d, WEEK_OPTIONS),
    end: endOfWeek(d, WEEK_OPTIONS),
  }
}

/** Build the 7 day range for a week (Mon-Sun). */
function getWeekDays(d: Date): Date[] {
  const { start, end } = getWeekRange(d)
  return eachDayOfInterval({ start, end })
}

/** Format the week range for display: "Mar 24 - Mar 30, 2025" */
function formatWeekRange(d: Date): string {
  const { start, end } = getWeekRange(d)
  const startStr = format(start, 'MMM d')
  const endStr = format(end, 'MMM d, yyyy')
  return `${startStr} - ${endStr}`
}

/** Get all calendar dates for a month grid (including padding from prev/next months). */
function getMonthGridDays(d: Date): Date[] {
  const monthStart = startOfMonth(d)
  const monthEnd = endOfMonth(d)
  const gridStart = startOfWeek(monthStart, WEEK_OPTIONS)
  const gridEnd = endOfWeek(monthEnd, WEEK_OPTIONS)
  return eachDayOfInterval({ start: gridStart, end: gridEnd })
}

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const [mode, setMode] = useState<JournalMode>('daily')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  // Track per-day pageIds that were created by handleAddBlock so we can
  // immediately show BlockTree without waiting for a full refetch.
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())
  const { load } = useBlockStore()

  /** Fetch all pages and build a dateStr->pageId lookup. */
  const fetchPages = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      const map = new Map<string, string>()
      for (const b of resp.items) {
        if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) {
          map.set(b.content, b.id)
        }
      }
      setPageMap(map)
    } catch {
      setPageMap(new Map())
    }
    setLoading(false)
  }, [])

  // Fetch pages on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run on mount
  useEffect(() => {
    fetchPages()
  }, [])

  /** Set of date strings that have pages — for calendar highlighting. */
  const datesWithPages = useMemo(() => {
    const set = new Set<string>()
    for (const k of pageMap.keys()) set.add(k)
    for (const k of createdPages.keys()) set.add(k)
    return set
  }, [pageMap, createdPages])

  /** Build a DayEntry from a Date. */
  const makeDayEntry = useCallback(
    (d: Date): DayEntry => {
      const dateStr = formatDate(d)
      return {
        date: d,
        dateStr,
        displayDate: formatDateDisplay(d),
        pageId: createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null,
      }
    },
    [pageMap, createdPages],
  )

  /** Add a new block under a specific day's page, creating the page if needed. */
  async function handleAddBlock(dateStr: string) {
    let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null

    if (!pageId) {
      const page = await createBlock({ blockType: 'page', content: dateStr })
      pageId = page.id
      setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
      setPageMap((prev) => new Map(prev).set(dateStr, pageId as string))
    }

    await createBlock({
      blockType: 'content',
      content: '',
      parentId: pageId,
    })

    await load(pageId)
  }

  // ── Navigation handlers ─────────────────────────────────────────────

  function goToday() {
    setCurrentDate(new Date())
  }

  function goPrev() {
    setCurrentDate((d) => {
      if (mode === 'daily') return subDays(d, 1)
      if (mode === 'weekly') return subWeeks(d, 1)
      return subMonths(d, 1)
    })
  }

  function goNext() {
    setCurrentDate((d) => {
      if (mode === 'daily') return addDays(d, 1)
      if (mode === 'weekly') return addWeeks(d, 1)
      return addMonths(d, 1)
    })
  }

  /** Navigate to a specific date, optionally switching mode. */
  function navigateToDate(date: Date, newMode?: JournalMode) {
    setCurrentDate(date)
    if (newMode) setMode(newMode)
    setCalendarOpen(false)
  }

  // ── Calendar picker event handlers ──────────────────────────────────

  function handleCalendarDayClick(day: Date) {
    navigateToDate(day, 'daily')
  }

  function handleCalendarWeekNumberClick(_weekNumber: number, dates: Date[]) {
    if (dates.length > 0) {
      navigateToDate(dates[0], 'weekly')
    }
  }

  // ── Date display for each mode ──────────────────────────────────────

  function getDateDisplay(): string {
    if (mode === 'daily') return formatDateDisplay(currentDate)
    if (mode === 'weekly') return formatWeekRange(currentDate)
    return format(currentDate, 'MMMM yyyy')
  }

  function getNavLabel(): { prev: string; next: string } {
    if (mode === 'daily') return { prev: 'Previous day', next: 'Next day' }
    if (mode === 'weekly') return { prev: 'Previous week', next: 'Next week' }
    return { prev: 'Previous month', next: 'Next month' }
  }

  // ── Render helpers ──────────────────────────────────────────────────

  const todayStr = formatDate(new Date())
  const navLabels = getNavLabel()

  /** Render a single day section with BlockTree. */
  function renderDaySection(entry: DayEntry, headingLevel: 'h2' | 'h3' = 'h3') {
    const isToday = entry.dateStr === todayStr
    const Heading = headingLevel

    return (
      <section key={entry.dateStr} aria-label={`Journal for ${entry.displayDate}`}>
        <div className="flex items-center gap-2 mb-2">
          <Heading
            className={cn(
              headingLevel === 'h2'
                ? 'text-base font-medium'
                : 'text-sm font-medium text-muted-foreground',
              isToday && headingLevel === 'h3' && 'text-foreground',
            )}
          >
            {entry.displayDate}
            {isToday && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">(Today)</span>
            )}
          </Heading>
          {entry.pageId && onNavigateToPage && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${entry.dateStr} in editor`}
              onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {entry.pageId && <BlockTree parentId={entry.pageId} />}

        {!entry.pageId && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            <CalendarIcon className="mx-auto mb-2 h-5 w-5" />
            No blocks for {entry.dateStr}.
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={() => handleAddBlock(entry.dateStr)}
            >
              <Plus className="h-4 w-4" />
              Add your first block
            </Button>
          </div>
        )}

        <div className="mt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => handleAddBlock(entry.dateStr)}
          >
            <Plus className="h-4 w-4" />
            Add block
          </Button>
        </div>
      </section>
    )
  }

  /** Render daily view — single day with full BlockTree. */
  function renderDaily() {
    const entry = makeDayEntry(currentDate)
    return <div className="space-y-4">{renderDaySection(entry, 'h2')}</div>
  }

  /** Render weekly view — Mon-Sun, each day as a section. */
  function renderWeekly() {
    const days = getWeekDays(currentDate)
    return (
      <div className="space-y-6">
        {days.map((d) => {
          const entry = makeDayEntry(d)
          const isToday = entry.dateStr === todayStr
          return renderDaySection(entry, isToday ? 'h2' : 'h3')
        })}
      </div>
    )
  }

  /** Render monthly view — calendar grid with content indicators. */
  function renderMonthly() {
    const gridDays = getMonthGridDays(currentDate)
    const weekDayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    return (
      <table
        className="w-full border-collapse"
        aria-label={`Calendar for ${format(currentDate, 'MMMM yyyy')}`}
      >
        <thead>
          <tr>
            {weekDayHeaders.map((day) => (
              <th
                key={day}
                scope="col"
                className="p-2 text-center text-xs font-medium text-muted-foreground"
              >
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Render rows of 7 days */}
          {Array.from({ length: Math.ceil(gridDays.length / 7) }, (_, rowIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: calendar rows are stable by position
            <tr key={rowIdx}>
              {gridDays.slice(rowIdx * 7, rowIdx * 7 + 7).map((d) => {
                const dateStr = formatDate(d)
                const isCurrentMonth = isSameMonth(d, currentDate)
                const isToday = dateStr === todayStr
                const hasContent = datesWithPages.has(dateStr)

                return (
                  <td key={dateStr} className="p-0">
                    <button
                      type="button"
                      aria-label={`${formatDateDisplay(d)}${hasContent ? ', has content' : ''}`}
                      className={cn(
                        'relative flex w-full flex-col items-center justify-center rounded-md p-2 text-sm transition-colors hover:bg-accent cursor-pointer',
                        !isCurrentMonth && 'text-muted-foreground opacity-40',
                        isToday && 'bg-accent font-bold',
                        hasContent && isCurrentMonth && 'font-medium',
                      )}
                      onClick={() => navigateToDate(d, 'daily')}
                    >
                      <span>{d.getDate()}</span>
                      {hasContent && (
                        <span
                          className={cn(
                            'absolute bottom-1 h-1.5 w-1.5 rounded-full',
                            isCurrentMonth ? 'bg-primary' : 'bg-muted-foreground',
                          )}
                          aria-hidden="true"
                          data-testid="content-dot"
                        />
                      )}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // ── Highlighted days for the floating calendar picker ────────────────

  const highlightedCalendarDays = useMemo(() => {
    const days: Date[] = []
    for (const dateStr of datesWithPages) {
      const parts = dateStr.split('-')
      if (parts.length === 3) {
        days.push(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])))
      }
    }
    return days
  }, [datesWithPages])

  // ── Main render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header: Mode buttons + navigation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Mode switcher */}
        <div className="flex items-center gap-1" role="tablist" aria-label="Journal view mode">
          {(['daily', 'weekly', 'monthly'] as const).map((m) => (
            <Button
              key={m}
              variant={mode === m ? 'secondary' : 'ghost'}
              size="xs"
              role="tab"
              aria-selected={mode === m}
              aria-label={`${m.charAt(0).toUpperCase() + m.slice(1)} view`}
              onClick={() => setMode(m)}
            >
              {m === 'daily' ? 'Day' : m === 'weekly' ? 'Week' : 'Month'}
            </Button>
          ))}
        </div>

        {/* Date navigation */}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label={navLabels.prev} onClick={goPrev}>
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span
            className="min-w-[160px] text-center text-sm font-medium"
            data-testid="date-display"
          >
            {getDateDisplay()}
          </span>

          <Button variant="ghost" size="icon-xs" aria-label={navLabels.next} onClick={goNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>

          <Button variant="outline" size="xs" onClick={goToday} aria-label="Go to today">
            Today
          </Button>

          {/* Floating calendar picker */}
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Open calendar picker">
                <CalendarIcon className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={currentDate}
                onSelect={(day) => day && handleCalendarDayClick(day)}
                defaultMonth={currentDate}
                weekStartsOn={1}
                showWeekNumber
                showOutsideDays
                onWeekNumberClick={handleCalendarWeekNumberClick}
                modifiers={{
                  hasContent: highlightedCalendarDays,
                }}
                modifiersClassNames={{
                  hasContent: 'has-content-dot',
                }}
              />
              <style>{`
                .has-content-dot { position: relative; }
                .has-content-dot::after {
                  content: '';
                  position: absolute;
                  bottom: 2px;
                  left: 50%;
                  transform: translateX(-50%);
                  width: 4px;
                  height: 4px;
                  border-radius: 50%;
                  background: hsl(var(--primary));
                }
              `}</style>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Loading indicator on initial fetch */}
      {loading && (
        <div className="space-y-1" data-testid="loading-skeleton">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-8 w-full rounded-lg" />
        </div>
      )}

      {/* View content */}
      {!loading && mode === 'daily' && renderDaily()}
      {!loading && mode === 'weekly' && renderWeekly()}
      {!loading && mode === 'monthly' && renderMonthly()}
    </div>
  )
}
