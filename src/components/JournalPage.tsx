/**
 * JournalPage — daily/weekly/monthly journal view backed by BlockTree.
 *
 * Three viewing modes:
 * - **Daily** (default): One day with prev/next navigation and today button.
 * - **Weekly**: Mon-Sun of one week, each day as a section with BlockTree.
 * - **Monthly**: Calendar grid showing content indicators; click to go to daily.
 *
 * A floating calendar date picker (react-day-picker in a positioned dropdown)
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
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { createBlock, listBlocks } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { useJournalStore } from '../stores/journal'
import { BlockTree } from './BlockTree'
import { EmptyState } from './EmptyState'

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

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const { mode, currentDate } = useJournalStore()
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
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

  // ── Render helpers ──────────────────────────────────────────────────

  const todayStr = formatDate(new Date())

  /** Render a single day section with heading + BlockTree or compact empty state. */
  function renderDaySection(
    entry: DayEntry,
    headingLevel: 'h2' | 'h3' = 'h3',
    options?: { hideHeading?: boolean; compact?: boolean },
  ) {
    const isToday = entry.dateStr === todayStr
    const Heading = headingLevel === 'h2' ? 'h2' : 'h3'
    const compact = options?.compact ?? false

    return (
      <section key={entry.dateStr} aria-label={`Journal for ${entry.displayDate}`}>
        {/* Day heading — hidden in daily mode since header shows the date */}
        {!options?.hideHeading && (
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
        )}
        {/* In daily mode (heading hidden), still show the "open in editor" link */}
        {options?.hideHeading && entry.pageId && onNavigateToPage && (
          <div className="flex items-center gap-2 mb-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              aria-label={`Open ${entry.dateStr} in editor`}
              onClick={() => onNavigateToPage(entry.pageId as string, entry.dateStr)}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              Open in page editor
            </Button>
          </div>
        )}

        {entry.pageId && <BlockTree parentId={entry.pageId} onNavigateToPage={onNavigateToPage} />}

        {/* Empty state: compact for multi-day views, full for daily */}
        {!entry.pageId &&
          (compact ? (
            <button
              type="button"
              className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50 transition-colors"
              onClick={() => handleAddBlock(entry.dateStr)}
            >
              <Plus className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
              Add block
            </button>
          ) : (
            <EmptyState
              icon={CalendarIcon}
              message={`No blocks for ${entry.displayDate}.`}
              compact
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3 mx-auto flex items-center gap-1"
                  onClick={() => handleAddBlock(entry.dateStr)}
                >
                  <Plus className="h-4 w-4" />
                  Add your first block
                </Button>
              }
            />
          ))}

        {/* "Add block" button — only shown when there IS content (otherwise the empty state has the CTA) */}
        {entry.pageId && (
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
        )}
      </section>
    )
  }

  /** Render daily view — single day, heading hidden (header shows date). */
  function renderDaily() {
    const entry = makeDayEntry(currentDate)
    return <div className="space-y-4">{renderDaySection(entry, 'h2', { hideHeading: true })}</div>
  }

  /** Render weekly view — Mon-Sun, each day as a compact section with separator. */
  function renderWeekly() {
    const days = getWeekDays(currentDate)
    return (
      <div className="space-y-1">
        {days.map((d, i) => {
          const entry = makeDayEntry(d)
          const isToday = entry.dateStr === todayStr
          return (
            <div key={entry.dateStr}>
              {i > 0 && <div className="border-t border-border my-4" />}
              {renderDaySection(entry, isToday ? 'h2' : 'h3', { compact: true })}
            </div>
          )
        })}
      </div>
    )
  }

  /** Render monthly view — stacked day sections for the whole month (compact, with separators). */
  function renderMonthly() {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

    return (
      <div className="space-y-1">
        {days.map((d, i) => {
          const entry = makeDayEntry(d)
          const isToday = entry.dateStr === todayStr
          return (
            <div key={entry.dateStr}>
              {i > 0 && <div className="border-t border-border my-4" />}
              {renderDaySection(entry, isToday ? 'h2' : 'h3', { compact: true })}
            </div>
          )
        })}
      </div>
    )
  }

  // ── Highlighted days for the floating calendar picker ────────────────

  // ── Main render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
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

// ── Journal Controls (rendered in App header bar) ─────────────────────

/** Journal mode/date controls — rendered in the App header for space efficiency. */
export function JournalControls(): React.ReactElement {
  const { mode, currentDate, setMode, setCurrentDate, navigateToDate } = useJournalStore()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [pageMap, setPageMap] = useState<Set<string>>(new Set())

  // Fetch page map for calendar highlighting
  useEffect(() => {
    listBlocks({ blockType: 'page', limit: 500 })
      .then((resp) => {
        const dates = new Set<string>()
        for (const b of resp.items) {
          if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) dates.add(b.content)
        }
        setPageMap(dates)
      })
      .catch(() => {})
  }, [])

  const highlightedDays = useMemo(() => {
    const days: Date[] = []
    for (const dateStr of pageMap) {
      const parts = dateStr.split('-')
      if (parts.length === 3) {
        days.push(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])))
      }
    }
    return days
  }, [pageMap])

  function goPrev() {
    if (mode === 'daily') setCurrentDate(subDays(currentDate, 1))
    else if (mode === 'weekly') setCurrentDate(subWeeks(currentDate, 1))
    else setCurrentDate(subMonths(currentDate, 1))
  }

  function goNext() {
    if (mode === 'daily') setCurrentDate(addDays(currentDate, 1))
    else if (mode === 'weekly') setCurrentDate(addWeeks(currentDate, 1))
    else setCurrentDate(addMonths(currentDate, 1))
  }

  function getDateDisplay(): string {
    if (mode === 'daily') return formatDateDisplay(currentDate)
    if (mode === 'weekly') return formatWeekRange(currentDate)
    return format(currentDate, 'MMMM yyyy')
  }

  const navLabels = {
    prev:
      mode === 'daily' ? 'Previous day' : mode === 'weekly' ? 'Previous week' : 'Previous month',
    next: mode === 'daily' ? 'Next day' : mode === 'weekly' ? 'Next week' : 'Next month',
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      {/* Mode switcher */}
      <div className="flex items-center gap-0.5" role="tablist" aria-label="Journal view mode">
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

      <div className="flex-1" />

      {/* Date navigation */}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-xs" aria-label={navLabels.prev} onClick={goPrev}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[140px] text-center text-sm font-medium" data-testid="date-display">
          {getDateDisplay()}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label={navLabels.next} onClick={goNext}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setCurrentDate(new Date())}
          aria-label="Go to today"
        >
          Today
        </Button>
        <div className="relative">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open calendar picker"
            onClick={() => setCalendarOpen((o) => !o)}
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
          {calendarOpen && (
            <>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
              <div className="fixed inset-0 z-40" onClick={() => setCalendarOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 rounded-md border bg-popover p-2 shadow-md">
                <Calendar
                  mode="single"
                  selected={currentDate}
                  onSelect={(day) => {
                    if (day) {
                      navigateToDate(day, 'daily')
                      setCalendarOpen(false)
                    }
                  }}
                  defaultMonth={currentDate}
                  weekStartsOn={1}
                  showWeekNumber
                  showOutsideDays
                  onWeekNumberClick={(_wn: number, dates: Date[]) => {
                    if (dates.length > 0) {
                      navigateToDate(dates[0], 'weekly')
                      setCalendarOpen(false)
                    }
                  }}
                  onMonthClick={(month: Date) => {
                    navigateToDate(month, 'monthly')
                    setCalendarOpen(false)
                  }}
                  modifiers={{ hasContent: highlightedDays }}
                  modifiersClassNames={{ hasContent: 'has-content-dot' }}
                />
                <style>{`
                  .has-content-dot { position: relative; }
                  .has-content-dot::after {
                    content: '';
                    position: absolute;
                    bottom: 2px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 5px;
                    height: 5px;
                    border-radius: 50%;
                    background: hsl(var(--primary));
                  }
                `}</style>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
