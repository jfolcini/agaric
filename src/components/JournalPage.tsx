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
  format,
  isAfter,
  isBefore,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Skeleton } from '@/components/ui/skeleton'
import type { DayEntry } from '../lib/date-utils'
import {
  formatDate,
  formatDateDisplay,
  formatWeekRange,
  MAX_JOURNAL_DATE,
  MIN_JOURNAL_DATE,
} from '../lib/date-utils'
import { createBlock, listBlocks } from '../lib/tauri'
import { insertTemplateBlocks, loadJournalTemplate } from '../lib/template-utils'
import { useBlockStore } from '../stores/blocks'
import { useJournalStore } from '../stores/journal'
import { useResolveStore } from '../stores/resolve'
import { AgendaView } from './journal/AgendaView'
import { DailyView } from './journal/DailyView'
import { MonthlyView } from './journal/MonthlyView'
import { WeeklyView } from './journal/WeeklyView'

export type { DayEntry } from '../lib/date-utils'
// Re-export for backward compatibility
export { MAX_JOURNAL_DATE, MIN_JOURNAL_DATE } from '../lib/date-utils'

interface JournalPageProps {
  /** Called when a block is clicked — navigates to block editor. */
  onBlockClick?: ((blockId: string) => void) | undefined
  /** Called to navigate to a page for editing. */
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
}

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const { t } = useTranslation()
  const { mode, currentDate, scrollToDate, scrollToPanel, clearScrollTarget } = useJournalStore()
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  // Track per-day pageIds that were created by handleAddBlock so we can
  // immediately show BlockTree without waiting for a full refetch.
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())
  const load = useBlockStore((s) => s.load)

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

  /** Add a new block under a specific day's page, creating the page if needed. */
  const handleAddBlock = useCallback(
    async (dateStr: string, autoFocus = false) => {
      try {
        let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null
        const isNewPage = !pageId

        if (!pageId) {
          const page = await createBlock({ blockType: 'page', content: dateStr })
          pageId = page.id
          setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
          setPageMap((prev) => new Map(prev).set(dateStr, pageId as string))
          useResolveStore.getState().set(page.id, dateStr, false)
        }

        if (isNewPage) {
          const { template: journalTemplate, duplicateWarning } = await loadJournalTemplate()
          if (duplicateWarning) {
            toast.warning(duplicateWarning)
          }
          if (journalTemplate) {
            const ids = await insertTemplateBlocks(journalTemplate.id, pageId, {
              pageTitle: dateStr,
            })
            await load(pageId)
            if (autoFocus && ids.length > 0) {
              useBlockStore.setState({ focusedBlockId: ids[0] ?? null })
            }
          } else {
            const block = await createBlock({
              blockType: 'content',
              content: '',
              parentId: pageId,
            })
            await load(pageId)
            if (autoFocus && block.id) {
              useBlockStore.setState({ focusedBlockId: block.id })
            }
          }
        } else {
          const block = await createBlock({
            blockType: 'content',
            content: '',
            parentId: pageId,
          })
          await load(pageId)
          if (autoFocus && block.id) {
            useBlockStore.setState({ focusedBlockId: block.id })
          }
        }
      } catch {
        toast.error(t('journal.addBlockFailed'))
      }
    },
    [createdPages, pageMap, load, t],
  )

  // Auto-create today's page on mount in daily mode
  const autoCreatedRef = useRef(false)

  useEffect(() => {
    if (loading) return
    if (autoCreatedRef.current) return
    if (mode !== 'daily') return
    const todayStr = formatDate(new Date())
    if (todayStr !== formatDate(currentDate)) return
    if (createdPages.has(todayStr) || pageMap.has(todayStr)) return
    autoCreatedRef.current = true
    handleAddBlock(todayStr, true)
  }, [loading, mode, currentDate, pageMap, createdPages, handleAddBlock])

  // Keyboard shortcut for new block in daily mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'daily') return
      const dateStr = formatDate(currentDate)
      if (createdPages.has(dateStr) || pageMap.has(dateStr)) return
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        return
      if (e.key === 'Enter' || e.key === 'n') {
        e.preventDefault()
        handleAddBlock(dateStr, true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, currentDate, createdPages, pageMap, handleAddBlock])

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
      {!loading && mode === 'daily' && (
        <DailyView
          entry={makeDayEntry(currentDate)}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'weekly' && (
        <WeeklyView
          makeDayEntry={makeDayEntry}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'monthly' && (
        <MonthlyView
          makeDayEntry={makeDayEntry}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'agenda' && <AgendaView onNavigateToPage={onNavigateToPage} />}
    </div>
  )
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

// ── Journal Controls (rendered in App header bar) ─────────────────────

/** Journal mode/date controls — rendered in the App header for space efficiency. */
export function JournalControls(): React.ReactElement {
  const { t } = useTranslation()
  const { mode, currentDate, setMode, setCurrentDate, navigateToDate, goToDateAndScroll } =
    useJournalStore()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [pageMap, setPageMap] = useState<Set<string>>(new Set())

  // Fetch page map for calendar highlighting
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run on mount
  useEffect(() => {
    listBlocks({ blockType: 'page', limit: 500 })
      .then((resp) => {
        const dates = new Set<string>()
        for (const b of resp.items) {
          if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) dates.add(b.content)
        }
        setPageMap(dates)
      })
      .catch(() => toast.error(t('journal.loadCalendarFailed')))
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
    if (mode === 'agenda') return t('journal.tasks')
    if (mode === 'daily') return formatDateDisplay(currentDate)
    if (mode === 'weekly') return formatWeekRange(currentDate)
    return format(currentDate, 'MMMM yyyy')
  }

  const navLabels = {
    prev:
      mode === 'daily'
        ? t('journal.prevDay')
        : mode === 'weekly'
          ? t('journal.prevWeek')
          : t('journal.prevMonth'),
    next:
      mode === 'daily'
        ? t('journal.nextDay')
        : mode === 'weekly'
          ? t('journal.nextWeek')
          : t('journal.nextMonth'),
  }

  return (
    <div className="flex flex-1 items-center gap-2 flex-wrap">
      {/* Mode switcher */}
      <div className="flex items-center gap-0.5" role="tablist" aria-label="Journal view mode">
        {(['daily', 'weekly', 'monthly', 'agenda'] as const).map((m) => {
          const tabLabels: Record<string, string> = {
            daily: t('journal.dayTab'),
            weekly: t('journal.weekTab'),
            monthly: t('journal.monthTab'),
            agenda: t('journal.agendaTab'),
          }
          const ariaLabels: Record<string, string> = {
            daily: t('journal.dailyView'),
            weekly: t('journal.weeklyView'),
            monthly: t('journal.monthlyView'),
            agenda: t('journal.agendaView'),
          }
          return (
            <Button
              key={m}
              variant={mode === m ? 'secondary' : 'ghost'}
              size="xs"
              role="tab"
              aria-selected={mode === m}
              aria-label={ariaLabels[m]}
              onClick={() => setMode(m)}
            >
              {tabLabels[m]}
            </Button>
          )
        })}
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
            className="min-w-[100px] sm:min-w-[140px] text-center text-sm font-medium"
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
            aria-label={t('journal.goToToday')}
          >
            {t('journal.today')}
          </Button>
          <div className="relative">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('journal.openCalendar')}
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
                    navigateToDate(dates[0] as Date, 'weekly')
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
