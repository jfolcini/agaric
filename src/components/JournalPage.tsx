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
  isSameDay,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { logger } from '@/lib/logger'
import { useJournalAutoCreate } from '../hooks/useJournalAutoCreate'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import type { NavigateToPageFn } from '../lib/block-events'
import type { DayEntry } from '../lib/date-utils'
import {
  formatDate,
  formatDateDisplay,
  formatWeekRange,
  MAX_JOURNAL_DATE,
  MIN_JOURNAL_DATE,
} from '../lib/date-utils'
import { createBlock, createPageInSpace, listBlocks } from '../lib/tauri'
import {
  insertTemplateBlocks,
  insertTemplateBlocksFromString,
  loadJournalTemplate,
  loadJournalTemplateForSpace,
} from '../lib/template-utils'
import { useBlockStore } from '../stores/blocks'
import { useJournalStore } from '../stores/journal'
import { useNavigationStore } from '../stores/navigation'
import { pageBlockRegistry } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { AgendaView } from './journal/AgendaView'
import { DailyView } from './journal/DailyView'
import { JournalCalendarDropdown } from './journal/JournalCalendarDropdown'
import { MonthlyView } from './journal/MonthlyView'
import { WeeklyView } from './journal/WeeklyView'
import { LinkPreviewTooltip } from './LinkPreviewTooltip'
import { LoadingSkeleton } from './LoadingSkeleton'

export type { DayEntry } from '../lib/date-utils'
// Re-export for backward compatibility
export { MAX_JOURNAL_DATE, MIN_JOURNAL_DATE } from '../lib/date-utils'

interface JournalPageProps {
  /** Called when a block is clicked -- navigates to block editor. */
  onBlockClick?: ((blockId: string) => void) | undefined
  /** Called to navigate to a page for editing. */
  onNavigateToPage?: NavigateToPageFn | undefined
}

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const { t } = useTranslation()
  const { mode, currentDate, scrollToDate, scrollToPanel, clearScrollTarget } = useJournalStore(
    useShallow((s) => ({
      mode: s.mode,
      currentDate: s.currentDate,
      scrollToDate: s.scrollToDate,
      scrollToPanel: s.scrollToPanel,
      clearScrollTarget: s.clearScrollTarget,
    })),
  )
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  // Track per-day pageIds that were created by handleAddBlock so we can
  // immediately show BlockTree without waiting for a full refetch.
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())

  /** Fetch all pages and build a dateStr->pageId lookup. */
  const fetchPages = useCallback(async () => {
    setLoading(true)
    try {
      const start = performance.now()
      const resp = await listBlocks({ blockType: 'page', limit: 500 })
      const map = new Map<string, string>()
      for (const b of resp.items) {
        if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) {
          map.set(b.content, b.id)
        }
      }
      setPageMap(map)
      logger.debug('JournalPage', 'journal pages loaded', {
        pageCount: map.size,
        durationMs: Math.round(performance.now() - start),
      })
    } catch (err) {
      logger.warn('JournalPage', 'Failed to fetch journal pages, using empty map', undefined, err)
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
    async (dateStr: string) => {
      try {
        let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null
        const isNewPage = !pageId

        if (!pageId) {
          // BUG-1 / H-3b — route page creation through `createPageInSpace`
          // so the new daily journal page lands with its `space` ref
          // property set atomically (CreateBlock + SetProperty in one tx).
          // The legacy `createBlock({ blockType: 'page' })` path leaked
          // unscoped pages that disappeared from the PageBrowser list.
          const currentSpaceId = useSpaceStore.getState().currentSpaceId
          if (currentSpaceId == null) {
            // SpaceStore not yet hydrated — surface the failure instead
            // of silently creating an unscoped page (the symptom we are
            // fixing). The boot path normally hydrates space store
            // before Journal mounts; this branch is a defence-in-depth.
            throw new Error('No active space; cannot create journal page')
          }
          const newId = await createPageInSpace({ content: dateStr, spaceId: currentSpaceId })
          // Defensive: if the IPC returned a non-string (mock leak, schema
          // drift, …) treat it as a failure so we don't seed `createdPages`
          // with a non-string and render a phantom page.
          if (typeof newId !== 'string' || newId.length === 0) {
            throw new Error('createPageInSpace returned no page ULID')
          }
          pageId = newId
          setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
          setPageMap((prev) => new Map(prev).set(dateStr, pageId as string))
          useResolveStore.getState().set(newId, dateStr, false)
        }

        if (isNewPage) {
          // FEAT-3p5b — per-space `journal_template` text property on the
          // space block takes precedence over the legacy global
          // `journal-template` page. Falls through to the legacy path on
          // any failure (defensive: a broken per-space property must not
          // strand the user with no journal blocks at all).
          let perSpaceTemplate: string | null = null
          const currentSpaceId = useSpaceStore.getState().currentSpaceId
          if (currentSpaceId != null) {
            try {
              perSpaceTemplate = await loadJournalTemplateForSpace(currentSpaceId)
            } catch (err) {
              logger.warn(
                'JournalPage',
                'per-space journal template load failed; falling back to legacy',
                { spaceId: currentSpaceId },
                err,
              )
            }
          }

          if (perSpaceTemplate != null && perSpaceTemplate.trim() !== '') {
            const ids = await insertTemplateBlocksFromString(perSpaceTemplate, pageId, {
              pageTitle: dateStr,
            })
            await pageBlockRegistry.get(pageId)?.getState().load()
            if (ids.length > 0) {
              useBlockStore.setState({ focusedBlockId: ids[0] ?? null })
            }
          } else {
            const { template: journalTemplate, duplicateWarning } = await loadJournalTemplate()
            if (duplicateWarning) {
              toast.warning(duplicateWarning)
            }
            if (journalTemplate) {
              const ids = await insertTemplateBlocks(journalTemplate.id, pageId, {
                pageTitle: dateStr,
              })
              await pageBlockRegistry.get(pageId)?.getState().load()
              if (ids.length > 0) {
                useBlockStore.setState({ focusedBlockId: ids[0] ?? null })
              }
            } else {
              const block = await createBlock({
                blockType: 'content',
                content: '',
                parentId: pageId,
              })
              await pageBlockRegistry.get(pageId)?.getState().load()
              useBlockStore.setState({ focusedBlockId: block.id })
            }
          }
        } else {
          const block = await createBlock({
            blockType: 'content',
            content: '',
            parentId: pageId,
          })
          await pageBlockRegistry.get(pageId)?.getState().load()
          useBlockStore.setState({ focusedBlockId: block.id })
        }
      } catch (err) {
        logger.warn('JournalPage', 'addBlock failed', undefined, err)
        toast.error(t('journal.addBlockFailed'))
      }
    },
    [createdPages, pageMap, t],
  )

  // Auto-create the displayed day's page on mount / date change in daily mode
  // + keyboard shortcuts (Enter/n) to create a page when none exists
  useJournalAutoCreate({
    loading,
    mode,
    currentDate,
    pageMap,
    createdPages,
    handleAddBlock,
  })

  // ── Link preview tooltip — covers all blocks in the journal view ────
  const [journalContainerEl, setJournalContainerEl] = useState<HTMLDivElement | null>(null)
  // Stable DOM ref for usePrimaryFocus. Keeping this separate from the
  // callback-ref above (which powers LinkPreviewTooltip) avoids a rerender
  // loop from the registry re-running register() on every parent render.
  const journalDomRef = useRef<HTMLDivElement | null>(null)
  useRegisterPrimaryFocus(journalDomRef)
  const journalRef = useCallback((node: HTMLDivElement | null) => {
    setJournalContainerEl(node)
    journalDomRef.current = node
  }, [])

  // ── Main render ─────────────────────────────────────────────────────

  return (
    <div ref={journalRef} tabIndex={-1} className="space-y-4 focus:outline-none">
      {/* Loading indicator on initial fetch */}
      {loading && (
        <div aria-busy="true">
          <LoadingSkeleton count={3} height="h-10" data-testid="loading-skeleton" />
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

      {/* Link preview tooltip — covers all external links in journal */}
      <LinkPreviewTooltip container={journalContainerEl} />
    </div>
  )
}

// ── Global Date Controls (rendered in App header for non-journal views) ──

/** Compact date controls — Today button + Agenda button + calendar dropdown. Shown in all views. */
export function GlobalDateControls(): React.ReactElement {
  const { t } = useTranslation()
  const { currentDate, mode, navigateToDate } = useJournalStore(
    useShallow((s) => ({
      currentDate: s.currentDate,
      mode: s.mode,
      navigateToDate: s.navigateToDate,
    })),
  )
  const { currentView, setView } = useNavigationStore(
    useShallow((s) => ({ currentView: s.currentView, setView: s.setView })),
  )
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
      .catch((err) => {
        logger.warn('JournalPage', 'calendar page-dates fetch failed (daily)', undefined, err)
        toast.error(t('journal.loadCalendarFailed'))
      })
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

  function handleToday() {
    const today = new Date()
    setView('journal')
    navigateToDate(today, 'daily')
  }

  function handleAgenda() {
    const today = new Date()
    setView('journal')
    navigateToDate(today, 'agenda')
  }

  const isAgendaActive = currentView === 'journal' && mode === 'agenda'

  // UX-236: hide the Today button when already on today's daily journal — the
  // click would be a no-op. Only applies to daily mode inside the journal view;
  // weekly/monthly still benefit from a scroll-to-today, and non-journal views
  // should keep the jump-in affordance.
  const todayButtonHidden =
    currentView === 'journal' && mode === 'daily' && isSameDay(currentDate, new Date())

  function handleSelectDate(day: Date) {
    setView('journal')
    navigateToDate(day, 'daily')
    setCalendarOpen(false)
  }

  function handleSelectWeek(dates: Date[]) {
    if (dates.length > 0) {
      setView('journal')
      navigateToDate(dates[0] as Date, 'weekly')
      setCalendarOpen(false)
    }
  }

  function handleSelectMonth(month: Date) {
    setView('journal')
    navigateToDate(month, 'monthly')
    setCalendarOpen(false)
  }

  return (
    <div className="flex items-center gap-1">
      {!todayButtonHidden && (
        <Button
          variant="outline"
          size="xs"
          onClick={handleToday}
          aria-label={t('journal.goToToday')}
        >
          {t('journal.today')}
        </Button>
      )}
      {!isAgendaActive && (
        <Button
          variant="outline"
          size="xs"
          onClick={handleAgenda}
          aria-label={t('journal.goToAgenda')}
        >
          {t('journal.agenda')}
        </Button>
      )}
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
            onSelectDate={handleSelectDate}
            onSelectWeek={handleSelectWeek}
            onSelectMonth={handleSelectMonth}
            onClose={() => setCalendarOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

// ── Journal Controls (rendered in App header bar) ─────────────────────

/** Journal mode/date controls — rendered in the App header for space efficiency. */
export function JournalControls(): React.ReactElement {
  const { t } = useTranslation()
  const { mode, currentDate, setMode, setCurrentDate, navigateToDate, goToDateAndScroll } =
    useJournalStore(
      useShallow((s) => ({
        mode: s.mode,
        currentDate: s.currentDate,
        setMode: s.setMode,
        setCurrentDate: s.setCurrentDate,
        navigateToDate: s.navigateToDate,
        goToDateAndScroll: s.goToDateAndScroll,
      })),
    )
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
      .catch((err) => {
        logger.warn('JournalPage', 'calendar page-dates fetch failed (daily)', undefined, err)
        toast.error(t('journal.loadCalendarFailed'))
      })
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

  // UX-236: hide the Today button when already on today's daily journal.
  // JournalControls only renders inside `currentView === 'journal'`, so the
  // view-level leg of the expression used in GlobalDateControls collapses here.
  const todayButtonHidden = mode === 'daily' && isSameDay(currentDate, new Date())

  return (
    <div className="flex flex-1 items-center gap-2 flex-wrap" data-testid="journal-header">
      {/* Mode switcher */}
      <div
        className="flex items-center gap-0.5"
        role="tablist"
        aria-label={t('journal.viewModeLabel')}
      >
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

      {/* Date navigation — prev/next/date-display hidden in agenda mode (no
          date context), but Today + Agenda + calendar stay visible so the
          user can jump back into dated views (UX-235). */}
      <div className="flex items-center gap-1">
        {/* UX-260 sub-fix 2: surface the Alt+Left / Alt+Right / Alt+T
            shortcuts via Tooltips so users discover the bindings without
            opening the KeyboardShortcuts sheet. */}
        <TooltipProvider>
          {mode !== 'agenda' && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={navLabels.prev}
                    onClick={goPrev}
                    disabled={!canGoPrev}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {navLabels.prev} <kbd className="ml-1 text-xs">Alt+←</kbd>
                </TooltipContent>
              </Tooltip>
              <span
                className="min-w-[100px] sm:min-w-[140px] text-center text-sm font-medium"
                data-testid="date-display"
              >
                {getDateDisplay()}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={navLabels.next}
                    onClick={goNext}
                    disabled={!canGoNext}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {navLabels.next} <kbd className="ml-1 text-xs">Alt+→</kbd>
                </TooltipContent>
              </Tooltip>
            </>
          )}
          {!todayButtonHidden && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const today = new Date()
                    if (mode === 'agenda') {
                      setMode('daily')
                      setCurrentDate(today)
                    } else if (mode === 'weekly' || mode === 'monthly') {
                      goToDateAndScroll(today, formatDate(today))
                    } else {
                      setCurrentDate(today)
                    }
                  }}
                  aria-label={t('journal.goToToday')}
                >
                  {t('journal.today')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('journal.goToToday')} <kbd className="ml-1 text-xs">Alt+T</kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
        {mode !== 'agenda' && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              navigateToDate(new Date(), 'agenda')
            }}
            aria-label={t('journal.goToAgenda')}
          >
            {t('journal.agenda')}
          </Button>
        )}
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

      {/* Agenda mode: show title in place of date nav */}
      {mode === 'agenda' && (
        <span className="text-sm font-medium" data-testid="date-display">
          {getDateDisplay()}
        </span>
      )}
    </div>
  )
}
