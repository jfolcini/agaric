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
  isSameMonth,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { JournalCalendarDropdown } from '@/components/journal/JournalCalendarDropdown'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  formatDate,
  formatDateDisplay,
  formatWeekRange,
  getMaxJournalDate,
  getWeekRange,
  MIN_JOURNAL_DATE,
} from '@/lib/date-utils'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
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

  // Shared by the header's Today button and the phone-width Today action
  // inside the calendar dropdown, so the two can never drift apart.
  function goToToday() {
    const today = new Date()
    if (mode === 'agenda') {
      setMode('daily')
      setCurrentDate(today)
    } else if (mode === 'weekly' || mode === 'monthly') {
      goToDateAndScroll(today, formatDate(today))
    } else {
      setCurrentDate(today)
    }
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
    if (mode === 'daily') return format(currentDate, 'MMM d')
    if (mode === 'weekly') {
      const { start, end } = getWeekRange(currentDate)
      // Same-month weeks collapse to "Aug 24–30"; only a week that straddles
      // two months pays for the second month name.
      return isSameMonth(start, end)
        ? `${format(start, 'MMM d')}–${format(end, 'd')}`
        : `${format(start, 'MMM d')}–${format(end, 'MMM d')}`
    }
    return format(currentDate, 'MMM yyyy')
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
  const previousShortcut = getShortcutKeys('prevDayWeekMonth')
  const nextShortcut = getShortcutKeys('nextDayWeekMonth')
  const todayShortcut = getShortcutKeys('goToToday')

  return (
    // ONE row at every width. Below `sm` this used to be `flex-col`, which —
    // nested inside the App header's own `flex-col` — put the mode tabs, the
    // date stepper and the search trigger on three separate rows on a phone
    // (measured: a 148px-tall header at 360px). The row now fits by shrinking
    // the fixed chrome (see the `max-sm:*!` widths below) and letting the date
    // chip absorb whatever is left, so overflow is structurally impossible
    // rather than budgeted: every other child is fixed-width, and the chip
    // truncates.
    <div
      className="flex min-w-0 flex-1 items-center gap-2 max-sm:gap-0.5"
      data-testid="journal-header"
    >
      {/* Mode switcher */}
      <div
        className="flex shrink-0 items-center gap-0.5 max-sm:gap-0"
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
              // Phone width: a fixed 24px-wide square-ish tab around the
              // single glyph below. The `xs` size's coarse-pointer override
              // (`px-3`) made each tab 31-35px, so the five tabs alone ate
              // 174px of the 284px the header gets at 360px. 24×44 clears the
              // 24px WCAG 2.5.8 target floor and only the WIDTH shrinks — the
              // 44px touch height is untouched. `!` because the coarse-pointer
              // padding otherwise wins on source order (measured).
              className="max-sm:w-6! max-sm:px-0!"
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
              {/* Below 480px only the initial glyph shows; a native `title`
                  surfaces the full mode name on hover so a sighted user can
                  disambiguate (e.g. 'S' = Stream). The `aria-label` above
                  already covers screen readers. */}
              <span className="[@media(min-width:480px)]:hidden" title={ariaLabels[m]}>
                {tabLabels[m]?.charAt(0)}
              </span>
            </Button>
          )
        })}
      </div>

      <div className="hidden sm:block flex-1" />

      {/* Date navigation — prev/next/date-display hidden in agenda mode (no
          date context), but Today + Agenda + calendar stay visible so the
          user can jump back into dated views.
          `relative` anchors the calendar dropdown to the whole cluster: the
          trigger is the date chip in dated modes and the standalone icon in
          agenda/stream, and anchoring the popover to their shared parent lets
          both use ONE dropdown instance (right-aligned to the cluster, which
          is where it already sat when the icon was the only trigger). */}
      <div className="relative flex min-w-0 items-center gap-1 max-sm:gap-0.5">
        {/* Surface the current configurable bindings so users discover the
            shortcuts without opening the KeyboardShortcuts sheet. */}
        {!hidesDateNav && (
          <>
            <IconButton
              variant="ghost"
              size="icon-xs"
              // 28×44 on a phone — see the tab comment above for why the
              // coarse-pointer 44px WIDTH cannot be afforded on this row.
              className="max-sm:w-6!"
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
              aria-label={`${getDateDisplay()} · ${t('journal.openCalendar')}`}
              aria-expanded={calendarOpen}
              aria-haspopup="dialog"
              onClick={() => setCalendarOpen((o) => !o)}
            >
              <CalendarIcon className="h-4 w-4 max-sm:hidden" aria-hidden="true" />
              <span
                className="truncate max-sm:hidden sm:min-w-[100px] text-center"
                data-testid="date-display"
              >
                {getDateDisplay()}
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
              className="max-sm:w-6!"
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
        {!todayButtonHidden && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                // `outline` stays: on desktop Today sits next to the Agenda
                // button, which is also `outline`, so the pair reads as the
                // row's two word-buttons against the ghost icons. The report
                // that Today was "the only one with a border" was a PHONE
                // observation — Agenda is `hidden sm:inline-flex`, so the
                // border had no partner there. Rather than flatten the
                // desktop pair, the phone row drops the button entirely
                // (`max-sm:hidden`): it is the one control the 360px row has
                // no room for, and the dropdown below re-offers it one tap
                // deeper, where a phone user already goes to change dates.
                variant="outline"
                size="xs"
                className="max-sm:hidden"
                onClick={goToToday}
                aria-label={t('journal.goToToday')}
                aria-keyshortcuts={toAriaKeyshortcuts(todayShortcut)}
              >
                {t('journal.today')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('journal.goToToday')}{' '}
              <Kbd className="ml-1" aria-hidden="true">
                {todayShortcut}
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
        {/* Agenda / stream have no date chip to hang the picker on, so they
            keep the standalone calendar icon. Every other mode reaches the
            same dropdown through the date chip above. */}
        {hidesDateNav && (
          <IconButton
            variant="ghost"
            size="icon-xs"
            className="max-sm:w-6!"
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
            // Phone-only replacement for the header Today button hidden
            // above. `undefined` when Today would be a no-op anyway, so the
            // dropdown never offers a dead action.
            onToday={
              todayButtonHidden
                ? undefined
                : () => {
                    goToToday()
                    setCalendarOpen(false)
                  }
            }
            onClose={() => setCalendarOpen(false)}
          />
        )}
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
