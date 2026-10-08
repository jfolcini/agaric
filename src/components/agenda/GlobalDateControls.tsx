/**
 * GlobalDateControls — the App header's journal shortcuts on every view but
 * the journal itself (which renders `JournalControls`). Every handler calls
 * `setView('journal')`.
 *
 * Today is on every view: today's page is where most writing happens. The
 * Agenda + calendar pair only joins it on the content/navigation views in
 * `DATE_CONTROL_VIEWS`; on the tool/admin views and the page editor a bare
 * calendar trio reads as off-context (#1740).
 */

import { Calendar as CalendarIcon } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'
import { Button } from '@/components/ui/button'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore, type View } from '@/stores/navigation'

const DATE_CONTROL_VIEWS: ReadonlySet<View> = new Set<View>(['pages', 'search', 'tags', 'query'])

export function GlobalDateControls(): React.ReactElement {
  const { t } = useTranslation()
  const { currentDate, navigateToDate } = useJournalStore(
    useShallow((s) => ({ currentDate: s.currentDate, navigateToDate: s.navigateToDate })),
  )
  const { currentView, setView } = useNavigationStore(
    useShallow((s) => ({ currentView: s.currentView, setView: s.setView })),
  )
  const [calendarOpen, setCalendarOpen] = useState(false)

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
      <Button variant="outline" size="xs" onClick={handleToday} aria-label={t('journal.goToToday')}>
        {t('journal.today')}
      </Button>
      {DATE_CONTROL_VIEWS.has(currentView) && (
        <>
          {/* Hidden on a phone, where it would wrap the header onto a second
              row; Agenda stays in the journal's mode menu there. */}
          <Button
            variant="outline"
            size="xs"
            className="hidden sm:inline-flex"
            onClick={handleAgenda}
            aria-label={t('journal.goToAgenda')}
          >
            {t('journal.agenda')}
          </Button>
          <div className="relative">
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
                onSelectDate={handleSelectDate}
                onSelectWeek={handleSelectWeek}
                onSelectMonth={handleSelectMonth}
                onClose={() => setCalendarOpen(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
