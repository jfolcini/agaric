/**
 * JournalControls — mode switcher + prev/next/today + calendar rendered in
 * the App header for the journal view.
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
  isSameMonth,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, House } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { JournalModeMenu } from '@/components/journal/JournalModeMenu'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Kbd } from '@/components/ui/kbd'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getDateLocale } from '@/lib/date-locale'
import {
  formatDateDisplay,
  formatWeekRange,
  getMaxJournalDate,
  getWeekRange,
  MIN_JOURNAL_DATE,
} from '@/lib/date-utils'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
import { useJournalStore } from '@/stores/journal'

// #5441 — lazy: the calendar (react-day-picker) loads when it is first opened.
const JournalCalendarDropdown = lazy(() =>
  import('@/components/journal/JournalCalendarDropdown').then((m) => ({
    default: m.JournalCalendarDropdown,
  })),
)

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
  const { mode, currentDate, setMode, setCurrentDate, navigateToDate, goToToday } = useJournalStore(
    useShallow((s) => ({
      mode: s.mode,
      currentDate: s.currentDate,
      setMode: s.setMode,
      setCurrentDate: s.setCurrentDate,
      navigateToDate: s.navigateToDate,
      goToToday: s.goToToday,
    })),
  )
  const [calendarOpen, setCalendarOpen] = useState(false)
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
  // #757 — getMaxJournalDate() is evaluated per render so the +12-month
  // horizon tracks the wall clock instead of freezing at module load.
  const canGoNext = isBefore(currentDate, getMaxJournalDate())

  function getDateDisplay(): string {
    if (mode === 'agenda') return t('journal.tasks')
    if (mode === 'daily') return formatDateDisplay(currentDate)
    if (mode === 'weekly') return formatWeekRange(currentDate)
    return format(currentDate, 'MMMM yyyy', { locale: getDateLocale() })
  }

  /**
   * Phone-width variant of {@link getDateDisplay}.
   *
   * The full strings are the widest thing in the header by a wide margin —
   * measured at 360px: daily "Mon, Aug 24, 2026" is 123px and weekly
   * "Aug 24 - Aug 30, 2026" needs ~150px (it was being squeezed to 77px and
   * WRAPPING to three lines, which is what pushed the header to 112px tall).
   * The compact forms drop the weekday and the year — both are redundant
   * next to a calendar the user just navigated with — and cost ~46-60px.
   *
   * Rendered as a second span with mutually exclusive visibility classes
   * (same trick as the mode-tab labels below), so the accessible name and
   * every `data-testid="date-display"` assertion keep seeing the full string.
   */
  function getCompactDateDisplay(): string {
    if (mode === 'agenda') return t('journal.tasks')
    const locale = getDateLocale()
    if (mode === 'daily') return format(currentDate, 'MMM d', { locale })
    if (mode === 'weekly') {
      const { start, end } = getWeekRange(currentDate)
      // Same-month weeks collapse to "Aug 24–30"; only a week that straddles
      // two months pays for the second month name.
      return isSameMonth(start, end)
        ? `${format(start, 'MMM d', { locale })}–${format(end, 'd', { locale })}`
        : `${format(start, 'MMM d', { locale })}–${format(end, 'MMM d', { locale })}`
    }
    return format(currentDate, 'MMM yyyy', { locale })
  }

  const dateDisplay = getDateDisplay()

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

  // #1415 — agenda and stream have no per-day date cursor: agenda is a task
  // panel, the stream scrolls a fixed today→past column. Both hide the
  // prev/next date stepper + date display (the stepper would have nothing to
  // move). The calendar picker stays available in both.
  const hidesDateNav = mode === 'agenda' || mode === 'stream'
  const modeLabels: Record<JournalMode, string> = {
    daily: t('journal.dayTab'),
    weekly: t('journal.weekTab'),
    monthly: t('journal.monthTab'),
    stream: t('journal.streamTab'),
    agenda: t('journal.agendaTab'),
  }
  const modeViewLabels: Record<JournalMode, string> = {
    daily: t('journal.dailyView'),
    weekly: t('journal.weeklyView'),
    monthly: t('journal.monthlyView'),
    stream: t('journal.streamView'),
    agenda: t('journal.agendaView'),
  }
  const previousShortcut = getShortcutKeys('prevDayWeekMonth')
  const nextShortcut = getShortcutKeys('nextDayWeekMonth')
  const todayShortcut = getShortcutKeys('goToToday')

  return (
    // ONE row at every width: every child but the date chip is fixed-width,
    // and the chip truncates, so overflow is structurally impossible rather
    // than budgeted.
    <div
      className="flex min-w-0 flex-1 items-center gap-2 max-sm:gap-1"
      data-testid="journal-header"
    >
      {/* Mode switcher: tabs from lg up; below it one menu button, because the
          five tabs next to the date stepper and Today leave the date chip no
          room on a phone or a touch tablet. Manual activation:
          arrow keys move focus only, so passing a tab does not mount its view
          (Agenda fires IPC on mount); Enter, Space or a click selects. */}
      <Tabs
        value={mode}
        onValueChange={(next) => setMode(next as JournalMode)}
        activationMode="manual"
        className="contents"
      >
        {/* The header's own border is the line under these tabs. */}
        <TabsList
          className="shrink-0 border-b-0 max-lg:hidden"
          aria-label={t('journal.viewModeLabel')}
        >
          {JOURNAL_MODES.map((m) => (
            <TabsTrigger
              key={m}
              value={m}
              // The panel is JournalPage's, outside this tree, so the ids are ours.
              id={journalTabId(m)}
              aria-controls={journalPanelId(m)}
              aria-label={modeViewLabels[m]}
            >
              {modeLabels[m]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <JournalModeMenu
        className="lg:hidden"
        modes={JOURNAL_MODES}
        mode={mode}
        labels={modeLabels}
        onSelect={setMode}
      />

      <div className="hidden sm:block flex-1" />

      {/* Date navigation — prev/next/date-display hidden in agenda mode (no
          date context), but Today + calendar stay visible so the user can
          jump back into dated views.
          `relative` anchors the calendar dropdown to the whole cluster: the
          trigger is the date chip in dated modes and the standalone icon in
          agenda/stream, and anchoring the popover to their shared parent lets
          both use ONE dropdown instance (right-aligned to the cluster, which
          is where it already sat when the icon was the only trigger). */}
      <div className="relative flex min-w-0 items-center gap-1">
        {/* Surface the current configurable bindings so users discover the
            shortcuts without opening the KeyboardShortcuts sheet. */}
        {!hidesDateNav && (
          <>
            <IconButton
              variant="ghost"
              size="icon-xs"
              ariaLabel={navLabels.prev}
              aria-keyshortcuts={toAriaKeyshortcuts(previousShortcut)}
              tooltip={
                <>
                  {navLabels.prev}{' '}
                  <Kbd className="ml-1" aria-hidden="true">
                    {previousShortcut}
                  </Kbd>
                </>
              }
              onClick={goPrev}
              disabled={!canGoPrev}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            {/* The date IS the calendar trigger. It used to be inert text
                with a separate calendar IconButton pinned to the end of the
                row; that button cost a further 44px on a phone, and the date
                was already the thing a user taps at. Merging them is what
                buys the row its last control. In agenda/stream (no date
                chip) the standalone icon below takes over. */}
            <Button
              variant="ghost"
              size="xs"
              // `shrink` (the Button base is `shrink-0`) makes the chip the
              // ONE elastic item on the row: every other control is a fixed
              // width, so whatever the viewport cannot afford comes out of
              // the date text, which truncates. That is what makes "no
              // horizontal overflow" structural instead of a pixel budget
              // that a longer locale string could blow.
              className="min-w-0 shrink gap-1 text-sm font-medium max-sm:px-0.5!"
              aria-label={`${dateDisplay} · ${t('journal.openCalendar')}`}
              aria-expanded={calendarOpen}
              aria-haspopup="dialog"
              onClick={() => setCalendarOpen((o) => !o)}
            >
              <CalendarIcon className="max-sm:hidden" aria-hidden="true" />
              <span
                className="truncate max-sm:hidden lg:min-w-[100px] text-center"
                data-testid="date-display"
              >
                {dateDisplay}
              </span>
              {/* Phone-width label. `aria-hidden` keeps it out of the
                  accessible name (the `aria-label` above already carries the
                  full date) and out of axe's label-in-name comparison. */}
              <span className="truncate sm:hidden" aria-hidden="true">
                {getCompactDateDisplay()}
              </span>
            </Button>
            <IconButton
              variant="ghost"
              size="icon-xs"
              ariaLabel={navLabels.next}
              aria-keyshortcuts={toAriaKeyshortcuts(nextShortcut)}
              tooltip={
                <>
                  {navLabels.next}{' '}
                  <Kbd className="ml-1" aria-hidden="true">
                    {nextShortcut}
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
        {/* Always shown, on every mode and date: today's page is where most
            writing happens, so the way back to it never moves or vanishes.
            Below `md` it is a ghost icon: the word squeezes the date chip to
            one letter on a 360px phone. `!` because the outline variant's own
            classes otherwise win on source order. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="max-md:border-transparent! max-md:bg-transparent! max-md:shadow-none! max-md:active:bg-accent/80! [@media(pointer:coarse)]:min-w-11"
              onClick={goToToday}
              aria-label={t('journal.goToToday')}
              aria-keyshortcuts={toAriaKeyshortcuts(todayShortcut)}
            >
              <House className="size-4 md:hidden" aria-hidden="true" />
              <span className="max-md:hidden">{t('journal.today')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('journal.goToToday')}{' '}
            <Kbd className="ml-1" aria-hidden="true">
              {todayShortcut}
            </Kbd>
          </TooltipContent>
        </Tooltip>
        {/* Agenda / stream have no date chip to hang the picker on, so they
            keep the standalone calendar icon. Every other mode reaches the
            same dropdown through the date chip above. */}
        {hidesDateNav && (
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
        )}
        {calendarOpen && (
          <Suspense fallback={null}>
            <JournalCalendarDropdown
              currentDate={currentDate}
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
          </Suspense>
        )}
      </div>

      {/* Agenda mode: show title in place of date nav */}
      {mode === 'agenda' && (
        <span className="text-sm font-medium" data-testid="date-display">
          {dateDisplay}
        </span>
      )}
    </div>
  )
}
