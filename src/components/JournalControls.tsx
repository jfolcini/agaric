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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCalendarPageDates } from '../hooks/useCalendarPageDates'
import {
  formatDate,
  formatDateDisplay,
  formatWeekRange,
  MAX_JOURNAL_DATE,
  MIN_JOURNAL_DATE,
} from '../lib/date-utils'
import { useJournalStore } from '../stores/journal'
import { JournalCalendarDropdown } from './journal/JournalCalendarDropdown'

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
  const { highlightedDays } = useCalendarPageDates()

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
