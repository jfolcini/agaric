/**
 * JournalControls — mode switcher + prev/next/today + agenda + calendar
 * rendered in the App header for the journal view.
 *
 * Extracted from `JournalPage.tsx` under MAINT-119.
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
import { useMemo, useRef, useState } from 'react'
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
const JOURNAL_MODES = ['daily', 'weekly', 'monthly', 'agenda'] as const
type JournalMode = (typeof JOURNAL_MODES)[number]

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

  // WAI-ARIA tabs: horizontal roving tabindex with automatic activation —
  // arrow keys move focus AND switch mode (the tabs eagerly render their
  // associated view). Wraparound on Arrow{Left,Right}; Home/End jump to ends.
  function handleTablistKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = JOURNAL_MODES.length
    const currentIndex = JOURNAL_MODES.indexOf(mode as JournalMode)
    let nextIndex: number
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % count
        break
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + count) % count
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = count - 1
        break
      default:
        return
    }
    e.preventDefault()
    const target = JOURNAL_MODES[nextIndex] as JournalMode
    setMode(target)
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

  // UX-236: hide the Today button when already on today's daily journal.
  // JournalControls only renders inside `currentView === 'journal'`, so the
  // view-level leg of the expression used in GlobalDateControls collapses here.
  const todayButtonHidden = mode === 'daily' && isSameDay(currentDate, new Date())

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
              ref={(el) => {
                tabRefs.current[m] = el
              }}
              variant={mode === m ? 'secondary' : 'ghost'}
              size="xs"
              role="tab"
              aria-selected={mode === m}
              aria-label={ariaLabels[m]}
              tabIndex={mode === m ? 0 : -1}
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
          user can jump back into dated views (UX-235). */}
      <div className="flex items-center gap-1">
        {/* UX-260 sub-fix 2: surface the Alt+Left / Alt+Right / Alt+T
            shortcuts via Tooltips so users discover the bindings without
            opening the KeyboardShortcuts sheet. */}
        {mode !== 'agenda' && (
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
          {/* NOT migrated to IconButton (#1089): this is a positioned
              popover trigger whose dropdown placement logic is timing-
              sensitive to the trigger's DOM; the Tooltip wrapper regressed
              the calendar-dropdown positioning test. Kept as a bare Button. */}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('journal.openCalendar')}
            aria-expanded={calendarOpen}
            aria-haspopup="dialog"
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
