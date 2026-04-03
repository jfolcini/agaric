/**
 * JournalPage — daily/weekly/monthly/agenda journal view backed by BlockTree.
 *
 * Four viewing modes:
 * - **Daily** (default): One day with prev/next navigation and today button.
 * - **Weekly**: Mon-Sun of one week, each day as a section with BlockTree.
 * - **Monthly**: Calendar grid showing content indicators; click to go to daily.
 * - **Agenda**: Task panels (TODO / DOING / DONE) with collapsible sections
 *   that load blocks matching the `todo` property on demand (paginated).
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
  isAfter,
  isBefore,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../lib/tauri'
import {
  batchResolve,
  countAgendaBatch,
  countBacklinksBatch,
  createBlock,
  listBlocks,
  queryByProperty,
} from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { useJournalStore } from '../stores/journal'
import { useResolveStore } from '../stores/resolve'
import type { AgendaFilter } from './AgendaFilterBuilder'
import { AgendaFilterBuilder } from './AgendaFilterBuilder'
import { AgendaResults } from './AgendaResults'
import { BlockTree } from './BlockTree'
import { DonePanel } from './DonePanel'
import { DuePanel } from './DuePanel'
import { EmptyState } from './EmptyState'
import { LinkedReferences } from './LinkedReferences'

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

/** Earliest navigable journal date. */
export const MIN_JOURNAL_DATE = new Date(2020, 0, 1)

/** Latest navigable journal date (1 year from today). */
export const MAX_JOURNAL_DATE = addMonths(new Date(), 12)

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

// ── Viewport-aware calendar dropdown ──────────────────────────────────

interface JournalCalendarDropdownProps {
  currentDate: Date
  highlightedDays: Date[]
  onSelectDate: (day: Date) => void
  onSelectWeek: (dates: Date[]) => void
  onSelectMonth: (month: Date) => void
  onClose: () => void
}

function JournalCalendarDropdown({
  currentDate,
  highlightedDays,
  onSelectDate,
  onSelectWeek,
  onSelectMonth,
  onClose,
}: JournalCalendarDropdownProps): React.ReactElement {
  const calRef = useRef<HTMLDivElement>(null)
  const [flipAbove, setFlipAbove] = useState(false)
  const [shiftLeft, setShiftLeft] = useState(0)

  // Escape key closes the calendar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Check if calendar overflows viewport and flip above / shift horizontally
  useEffect(() => {
    const el = calRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()

    // Use visualViewport for accurate height (handles virtual keyboard)
    const vh = window.visualViewport?.height ?? window.innerHeight

    if (rect.bottom > vh - 8) {
      setFlipAbove(true)
    }
    // Prevent horizontal overflow on narrow viewports
    if (rect.left < 8) {
      setShiftLeft(8 - rect.left)
    }
  }, [])

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={calRef}
        role="dialog"
        aria-label="Date picker"
        className={`absolute right-0 z-50 rounded-md border bg-popover p-2 shadow-md ${
          flipAbove ? 'bottom-full mb-1' : 'top-full mt-1'
        }`}
        style={shiftLeft > 0 ? { transform: `translateX(${shiftLeft}px)` } : undefined}
      >
        <Calendar
          mode="single"
          selected={currentDate}
          onSelect={(day) => day && onSelectDate(day)}
          defaultMonth={currentDate}
          weekStartsOn={1}
          showWeekNumber
          showOutsideDays
          onWeekNumberClick={(_wn: number, dates: Date[]) => onSelectWeek(dates)}
          onMonthClick={(month: Date) => onSelectMonth(month)}
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
            background: var(--primary);
          }
        `}</style>
      </div>
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const {
    mode,
    currentDate,
    navigateToDate,
    scrollToDate,
    scrollToPanel,
    clearScrollTarget,
    goToDateAndPanel,
  } = useJournalStore()
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  // Track per-day pageIds that were created by handleAddBlock so we can
  // immediately show BlockTree without waiting for a full refetch.
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())
  const [agendaCounts, setAgendaCounts] = useState<Record<string, number>>({})
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({})
  const load = useBlockStore((s) => s.load)

  // ── Agenda filter state ────────────────────────────────────────────
  const [agendaFilters, setAgendaFilters] = useState<AgendaFilter[]>([])
  const [filteredBlocks, setFilteredBlocks] = useState<BlockRow[]>([])
  const [agendaLoading, setAgendaLoading] = useState(false)
  const [agendaHasMore, setAgendaHasMore] = useState(false)
  const [agendaCursor, setAgendaCursor] = useState<string | null>(null)
  const [agendaPageTitles, setAgendaPageTitles] = useState<Map<string, string>>(new Map())

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

  // Scroll to a specific day section when requested (e.g., Today button in weekly/monthly)
  useEffect(() => {
    if (!scrollToDate) return
    requestAnimationFrame(() => {
      const el = document.getElementById(`journal-${scrollToDate}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      clearScrollTarget()
    })
  }, [scrollToDate, clearScrollTarget])

  // Scroll to a specific panel (due/references/done) when requested from badges
  useEffect(() => {
    if (!scrollToPanel) return
    requestAnimationFrame(() => {
      const el = document.getElementById(`journal-${scrollToPanel}-panel`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      clearScrollTarget()
    })
  }, [scrollToPanel, clearScrollTarget])

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

  /** Entries for the current view (weekly/monthly) — used for badge count fetching. */
  const entries = useMemo(() => {
    if (mode === 'daily' || mode === 'agenda') return []
    const days =
      mode === 'weekly'
        ? getWeekDays(currentDate)
        : eachDayOfInterval({ start: startOfMonth(currentDate), end: endOfMonth(currentDate) })
    return days.map(makeDayEntry)
  }, [mode, currentDate, makeDayEntry])

  // Fetch badge counts for weekly/monthly views
  useEffect(() => {
    if (mode === 'daily' || mode === 'agenda') return
    const dates = entries.map((e) => e.dateStr)
    const pageIds = entries.filter((e) => e.pageId).map((e) => e.pageId as string)

    let cancelled = false
    async function fetchCounts() {
      const [agenda, backlinks] = await Promise.all([
        countAgendaBatch({ dates }),
        pageIds.length > 0
          ? countBacklinksBatch({ pageIds })
          : Promise.resolve({} as Record<string, number>),
      ])
      if (!cancelled) {
        setAgendaCounts(agenda)
        setBacklinkCounts(backlinks)
      }
    }
    fetchCounts().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode, entries])

  // ── Agenda filter execution ────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'agenda') return

    let cancelled = false
    setAgendaLoading(true)

    async function executeFilters() {
      try {
        let blocks: BlockRow[] = []

        if (agendaFilters.length === 0) {
          // Default: all blocks with any todo_state
          const resp = await queryByProperty({ key: 'todo_state', limit: 200 })
          blocks = resp.items
          setAgendaHasMore(resp.has_more)
          setAgendaCursor(resp.next_cursor)
        } else {
          // Execute each filter dimension and intersect
          const resultSets: Set<string>[] = []
          const allBlocks = new Map<string, BlockRow>()

          for (const filter of agendaFilters) {
            const ids = new Set<string>()

            if (filter.dimension === 'status') {
              for (const value of filter.values) {
                const resp = await queryByProperty({
                  key: 'todo_state',
                  valueText: value,
                  limit: 500,
                })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            } else if (filter.dimension === 'priority') {
              for (const value of filter.values) {
                const resp = await queryByProperty({
                  key: 'priority',
                  valueText: value,
                  limit: 500,
                })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            } else if (filter.dimension === 'dueDate') {
              // Map filter values to actual dates
              const today = new Date()
              const todayStr = today.toISOString().slice(0, 10)
              for (const value of filter.values) {
                if (value === 'Today') {
                  const resp = await listBlocks({
                    agendaDate: todayStr,
                    agendaSource: 'column:due_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'Overdue') {
                  // Get all blocks with due_date < today
                  // Use queryByProperty won't work directly for range queries
                  // For v1, skip complex date ranges -- just handle "Today"
                  // For other values, fetch all agenda items and filter client-side
                }
                // Simplified: for v1 just handle "Today" well
              }
            } else if (filter.dimension === 'tag') {
              for (const value of filter.values) {
                const resp = await listBlocks({ tagId: value, limit: 500 })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            }

            resultSets.push(ids)
          }

          // Intersect all result sets
          if (resultSets.length > 0) {
            let intersection = resultSets[0]
            for (let i = 1; i < resultSets.length; i++) {
              intersection = new Set([...intersection].filter((id) => resultSets[i].has(id)))
            }
            blocks = [...intersection].map((id) => allBlocks.get(id) as BlockRow).filter(Boolean)
          }

          setAgendaHasMore(false) // Client-side intersection doesn't support pagination
          setAgendaCursor(null)
        }

        if (!cancelled) {
          setFilteredBlocks(blocks.slice(0, 200))
          setAgendaLoading(false)

          // Resolve page titles for breadcrumbs
          const parentIds = [...new Set(blocks.map((b) => b.parent_id).filter(Boolean))] as string[]
          if (parentIds.length > 0) {
            const resolved = await batchResolve(parentIds)
            const titleMap = new Map<string, string>()
            for (const r of resolved) {
              titleMap.set(r.id, r.title ?? 'Untitled')
            }
            if (!cancelled) setAgendaPageTitles(titleMap)
          }
        }
      } catch {
        if (!cancelled) {
          setFilteredBlocks([])
          setAgendaLoading(false)
        }
      }
    }

    executeFilters()
    return () => {
      cancelled = true
    }
  }, [mode, agendaFilters])

  /** Load the next page of agenda results (used for default unfiltered view). */
  const loadMoreAgenda = useCallback(async () => {
    if (!agendaCursor) return
    setAgendaLoading(true)
    try {
      const resp = await queryByProperty({ key: 'todo_state', cursor: agendaCursor, limit: 200 })
      setFilteredBlocks((prev) => [...prev, ...resp.items])
      setAgendaHasMore(resp.has_more)
      setAgendaCursor(resp.next_cursor)
    } catch {
      // ignore
    }
    setAgendaLoading(false)
  }, [agendaCursor])

  /** Add a new block under a specific day's page, creating the page if needed. */
  async function handleAddBlock(dateStr: string) {
    try {
      let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null

      if (!pageId) {
        const page = await createBlock({ blockType: 'page', content: dateStr })
        pageId = page.id
        setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
        setPageMap((prev) => new Map(prev).set(dateStr, pageId as string))
        useResolveStore.getState().set(page.id, dateStr, false)
      }

      await createBlock({
        blockType: 'content',
        content: '',
        parentId: pageId,
      })

      await load(pageId)
    } catch {
      toast.error('Failed to add block')
    }
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
    const isClickable = mode !== 'daily'

    return (
      <section
        key={entry.dateStr}
        id={`journal-${entry.dateStr}`}
        aria-label={`Journal for ${entry.displayDate}`}
        className={cn(isToday && 'bg-accent/[0.04] rounded-lg px-3 py-2 -mx-3')}
      >
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
              {isClickable ? (
                <button
                  type="button"
                  className="hover:text-primary hover:underline underline-offset-2 cursor-pointer transition-colors"
                  onClick={() => navigateToDate(entry.date, 'daily')}
                  aria-label={`Go to daily view for ${entry.displayDate}`}
                >
                  {entry.displayDate}
                </button>
              ) : (
                entry.displayDate
              )}
              {isToday && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">(Today)</span>
              )}
            </Heading>
            {/* Count badges for weekly/monthly modes */}
            {mode !== 'daily' && mode !== 'agenda' && (
              <>
                {(agendaCounts[entry.dateStr] ?? 0) > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center rounded-full bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/50"
                    onClick={() => goToDateAndPanel(entry.date, 'due')}
                    aria-label={`${agendaCounts[entry.dateStr]} due items, click to view`}
                  >
                    {(agendaCounts[entry.dateStr] ?? 0) > 99 ? '99+' : agendaCounts[entry.dateStr]}{' '}
                    due
                  </button>
                )}
                {entry.pageId && (backlinkCounts[entry.pageId] ?? 0) > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50"
                    onClick={() => goToDateAndPanel(entry.date, 'references')}
                    aria-label={`${backlinkCounts[entry.pageId]} references, click to view`}
                  >
                    {(backlinkCounts[entry.pageId] ?? 0) > 99
                      ? '99+'
                      : backlinkCounts[entry.pageId]}{' '}
                    refs
                  </button>
                )}
              </>
            )}
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

        {/* DuePanel + LinkedReferences — only in daily mode */}
        {mode === 'daily' && entry.pageId && (
          <>
            <div id="journal-due-panel">
              <DuePanel date={entry.dateStr} onNavigateToPage={onNavigateToPage} />
            </div>
            <div id="journal-references-panel">
              <LinkedReferences pageId={entry.pageId} onNavigateToPage={onNavigateToPage} />
            </div>
            <div id="journal-done-panel">
              <DonePanel date={entry.dateStr} onNavigateToPage={onNavigateToPage} />
            </div>
          </>
        )}

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

  /** Render agenda view — filter builder + flat results list. */
  function renderAgenda() {
    return (
      <div className="agenda-view space-y-4">
        <AgendaFilterBuilder filters={agendaFilters} onFiltersChange={setAgendaFilters} />
        <AgendaResults
          blocks={filteredBlocks}
          loading={agendaLoading}
          hasMore={agendaHasMore}
          onLoadMore={loadMoreAgenda}
          onNavigateToPage={onNavigateToPage}
          hasActiveFilters={agendaFilters.length > 0}
          onClearFilters={() => setAgendaFilters([])}
          pageTitles={agendaPageTitles}
        />
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
      {!loading && mode === 'agenda' && renderAgenda()}
    </div>
  )
}

// ── Journal Controls (rendered in App header bar) ─────────────────────

/** Journal mode/date controls — rendered in the App header for space efficiency. */
export function JournalControls(): React.ReactElement {
  const { mode, currentDate, setMode, setCurrentDate, navigateToDate, goToDateAndScroll } =
    useJournalStore()
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

  const canGoPrev = isAfter(currentDate, MIN_JOURNAL_DATE)
  const canGoNext = isBefore(currentDate, MAX_JOURNAL_DATE)

  function getDateDisplay(): string {
    if (mode === 'agenda') return 'Tasks'
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
        {(['daily', 'weekly', 'monthly', 'agenda'] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? 'secondary' : 'ghost'}
            size="xs"
            role="tab"
            aria-selected={mode === m}
            aria-label={`${m.charAt(0).toUpperCase() + m.slice(1)} view`}
            onClick={() => setMode(m)}
          >
            {m === 'daily' ? 'Day' : m === 'weekly' ? 'Week' : m === 'monthly' ? 'Month' : 'Agenda'}
          </Button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Date navigation — hidden in agenda mode (no date context) */}
      {mode !== 'agenda' && (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={navLabels.prev}
            onClick={goPrev}
            disabled={!canGoPrev}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span
            className="min-w-[140px] text-center text-sm font-medium"
            data-testid="date-display"
          >
            {getDateDisplay()}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={navLabels.next}
            onClick={goNext}
            disabled={!canGoNext}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const today = new Date()
              if (mode === 'weekly' || mode === 'monthly') {
                goToDateAndScroll(today, formatDate(today))
              } else {
                setCurrentDate(today)
              }
            }}
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
              <JournalCalendarDropdown
                currentDate={currentDate}
                highlightedDays={highlightedDays}
                onSelectDate={(day) => {
                  navigateToDate(day, 'daily')
                  setCalendarOpen(false)
                }}
                onSelectWeek={(dates) => {
                  if (dates.length > 0) {
                    navigateToDate(dates[0], 'weekly')
                    setCalendarOpen(false)
                  }
                }}
                onSelectMonth={(month) => {
                  navigateToDate(month, 'monthly')
                  setCalendarOpen(false)
                }}
                onClose={() => setCalendarOpen(false)}
              />
            )}
          </div>
        </div>
      )}

      {/* Agenda mode: show title in place of date nav */}
      {mode === 'agenda' && (
        <span className="text-sm font-medium" data-testid="date-display">
          {getDateDisplay()}
        </span>
      )}
    </div>
  )
}
