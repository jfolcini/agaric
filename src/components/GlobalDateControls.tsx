/**
 * GlobalDateControls — compact Today + Agenda + calendar trio rendered in
 * the App header bar for non-journal views.
 *
 * Extracted from `JournalPage.tsx` under MAINT-119.
 */

import { isSameDay } from 'date-fns'
import { Calendar as CalendarIcon } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { useCalendarPageDates } from '../hooks/useCalendarPageDates'
import { useJournalStore } from '../stores/journal'
import { useNavigationStore } from '../stores/navigation'
import { JournalCalendarDropdown } from './journal/JournalCalendarDropdown'

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
  const { highlightedDays } = useCalendarPageDates()

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
