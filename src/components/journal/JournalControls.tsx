/**
 * JournalControls — mode switcher + prev/next/today + agenda + calendar
 * rendered in the App header for the journal view.
 *
 * Extracted from `JournalPage.tsx` under.
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCalendarPageDates } from '@/hooks/useCalendarPageDates'
import {
  formatDate,
  formatDateDisplay,
  formatWeekRange,
  getCalendarMonthRange,
  getMaxJournalDate,
  MIN_JOURNAL_DATE,
} from '@/lib/date-utils'
import { useJournalStore } from '@/stores/journal'

// Shared by the roving-tabindex keyboard handler and the `.map` below so the
// arrow-key navigation order always matches the rendered tab order.
const JOURNAL_MODES = ['daily', 'weekly', 'monthly', 'stream', 'agenda'] as const
type JournalMode = (typeof JOURNAL_MODES)[number]

/**
 * Stable DOM id for a mode tab. Shared with the rendered view panel
 * (`JournalPage`) so the tab's `aria-controls` and the panel's
 * `aria-labelledby` reference each other across the two subtrees (the
 * tablist lives in the App header, the panel in `JournalPage`).
 */
export function journalTabId(mode: string): string {
  return `journal-tab-${mode}`
}

/** Stable DOM id for the rendered view panel of a mode. See `journalTabId`. */
export function journalPanelId(mode: string): string {
  return `journal-panel-${mode}`
}

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
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  // Roving-tabindex focus target — the tab that currently owns focus within
  // the tablist. Distinct from `mode` (the ACTIVE/selected tab) because we use
  // WAI-ARIA *manual* activation: arrows/Home/End move focus only, so a user
  // can traverse the tablist without eagerly mounting each intermediate view
  // (AgendaView fires IPC on mount). Enter/Space (or click) commits the focused
  // tab to `mode`. Kept in sync whenever `mode` changes from outside (click,
  // Today button, calendar) so tabbing back into the tablist lands on the
  // active tab.
  const [rovingMode, setRovingMode] = useState<JournalMode>(mode as JournalMode)
  useEffect(() => {
    setRovingMode(mode as JournalMode)
  }, [mode])
  const calendarRange = useMemo(() => getCalendarMonthRange(currentDate), [currentDate])
  const { highlightedDays } = useCalendarPageDates(calendarRange)

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

  // WAI-ARIA tabs: horizontal roving tabindex with MANUAL activation (APG).
  // Arrow{Left,Right}/Home/End move DOM focus only (they update `rovingMode`,
  // not `mode`), so arrow-keying across the tablist never mounts intermediate
  // views. Enter/Space activates the focused tab (commits it to `mode`).
  // Wraparound on Arrow{Left,Right}; Home/End jump to ends.
  function handleTablistKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = JOURNAL_MODES.length
    const currentIndex = JOURNAL_MODES.indexOf(rovingMode)
    // Activate the focused tab on Enter/Space.
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      setMode(rovingMode)
      return
    }
    let nextIndex: number
    switch (e.key) {
      case 'ArrowRight': {
        nextIndex = (currentIndex + 1) % count
        break
      }
      case 'ArrowLeft': {
        nextIndex = (currentIndex - 1 + count) % count
        break
      }
      case 'Home': {
        nextIndex = 0
        break
      }
      case 'End': {
        nextIndex = count - 1
        break
      }
      default: {
        return
      }
    }
    e.preventDefault()
    const target = JOURNAL_MODES[nextIndex] as JournalMode
    // Move focus only — do NOT switch mode (manual activation).
    setRovingMode(target)
    tabRefs.current[target]?.focus()
  }

  const canGoPrev = isAfter(currentDate, MIN_JOURNAL_DATE)
  // #757 — getMaxJournalDate() is evaluated per render so the +12-month
  // horizon tracks the wall clock instead of freezing at module load.
  const canGoNext = isBefore(currentDate, getMaxJournalDate())

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

  // Hide the Today button when already on today's daily journal.
  // JournalControls only renders inside `currentView === 'journal'`, so the
  // view-level leg of the expression used in GlobalDateControls collapses here.
  // #1415 — the stream is permanently top-anchored at today, so the Today
  // button has no destination to jump to; hide it there too.
  const todayButtonHidden =
    (mode === 'daily' && isSameDay(currentDate, new Date())) || mode === 'stream'

  // #1415 — agenda and stream have no per-day date cursor: agenda is a task
  // panel, the stream scrolls a fixed today→past column. Both hide the
  // prev/next date stepper + date display (the stepper would have nothing to
  // move). The calendar picker stays available in both.
  const hidesDateNav = mode === 'agenda' || mode === 'stream'

  return (
    <div
      className="flex flex-1 flex-col sm:flex-row sm:items-center gap-2"
      data-testid="journal-header"
    >
      {/* Mode switcher */}
      <div
        className="flex items-center gap-0.5"
        role="tablist"
        aria-label={t('journal.viewModeLabel')}
        tabIndex={-1}
        onKeyDown={handleTablistKeyDown}
      >
        {JOURNAL_MODES.map((m) => {
          const tabLabels: Record<string, string> = {
            daily: t('journal.dayTab'),
            weekly: t('journal.weekTab'),
            monthly: t('journal.monthTab'),
            stream: t('journal.streamTab'),
            agenda: t('journal.agendaTab'),
          }
          const ariaLabels: Record<string, string> = {
            daily: t('journal.dailyView'),
            weekly: t('journal.weeklyView'),
            monthly: t('journal.monthlyView'),
            stream: t('journal.streamView'),
            agenda: t('journal.agendaView'),
          }
          return (
            <Button
              key={m}
              ref={(el) => {
                tabRefs.current[m] = el
              }}
              variant={mode === m ? 'secondary' : 'ghost'}
              size="xs"
              role="tab"
              id={journalTabId(m)}
              aria-selected={mode === m}
              // Only the SELECTED tab points at a panel: JournalPage mounts the
              // panel for the active mode only, so referencing an unmounted
              // panel from inactive tabs would dangle (axe aria-valid-attr-value).
              {...(mode === m ? { 'aria-controls': journalPanelId(m) } : {})}
              aria-label={ariaLabels[m]}
              // Roving tabindex: the focused tab (or the active tab when focus
              // is elsewhere) is the single tab stop; arrows move focus among
              // the rest. Manual activation — focus ≠ selection.
              tabIndex={rovingMode === m ? 0 : -1}
              onClick={() => setMode(m)}
            >
              {/* PEND: compact labels under ~480px so the four tabs don't
                  crowd the calendar icon out of row 1 on phones. The
                  `aria-label` above keeps the full word for screen readers. */}
              <span className="hidden [@media(min-width:480px)]:inline">{tabLabels[m]}</span>
              <span className="[@media(min-width:480px)]:hidden">{tabLabels[m]?.charAt(0)}</span>
            </Button>
          )
        })}
      </div>

      <div className="hidden sm:block flex-1" />

      {/* Date navigation — prev/next/date-display hidden in agenda mode (no
          date context), but Today + Agenda + calendar stay visible so the
          user can jump back into dated views. */}
      <div className="flex items-center gap-1">
        {/*  sub-fix 2: surface the Alt+Left / Alt+Right / Alt+T
            shortcuts via Tooltips so users discover the bindings without
            opening the KeyboardShortcuts sheet. */}
        {!hidesDateNav && (
          <>
            <IconButton
              variant="ghost"
              size="icon-xs"
              ariaLabel={navLabels.prev}
              tooltip={
                <>
                  {navLabels.prev}{' '}
                  <Kbd className="ml-1" aria-hidden="true">
                    Alt+←
                  </Kbd>
                </>
              }
              onClick={goPrev}
              disabled={!canGoPrev}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <span
              className="sm:min-w-[100px] text-center text-sm font-medium"
              data-testid="date-display"
            >
              {getDateDisplay()}
            </span>
            <IconButton
              variant="ghost"
              size="icon-xs"
              ariaLabel={navLabels.next}
              tooltip={
                <>
                  {navLabels.next}{' '}
                  <Kbd className="ml-1" aria-hidden="true">
                    Alt+→
                  </Kbd>
                </>
              }
              onClick={goNext}
              disabled={!canGoNext}
            >
              <ChevronRight className="h-4 w-4" />
            </IconButton>
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
              {t('journal.goToToday')}{' '}
              <Kbd className="ml-1" aria-hidden="true">
                Alt+T
              </Kbd>
            </TooltipContent>
          </Tooltip>
        )}
        {mode !== 'agenda' && (
          <Button
            variant="outline"
            size="xs"
            className="hidden sm:inline-flex"
            onClick={() => {
              navigateToDate(new Date(), 'agenda')
            }}
            aria-label={t('journal.goToAgenda')}
          >
            {t('journal.agenda')}
          </Button>
        )}
        <div className="relative">
          <IconButton
            variant="ghost"
            size="icon-xs"
            ariaLabel={t('journal.openCalendar')}
            tooltip={t('journal.openCalendar')}
            aria-expanded={calendarOpen}
            aria-haspopup="dialog"
            onClick={() => setCalendarOpen((o) => !o)}
          >
            <CalendarIcon className="h-4 w-4" />
          </IconButton>
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
