import { startOfWeek } from 'date-fns'
import type React from 'react'
import { type ButtonHTMLAttributes, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarDay, Modifiers } from 'react-day-picker'
import { useTranslation } from 'react-i18next'
import { Calendar } from '@/components/ui/calendar'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { useBlockPropertyEvents } from '../../hooks/useBlockPropertyEvents'
import { useWeekStart } from '../../hooks/useWeekStart'
import { formatDate, getWeekOptions } from '../../lib/date-utils'
import { countAgendaBatchBySource } from '../../lib/tauri'

/** Compute ~42 date strings (6 weeks) for the calendar view centred on the given month. */
function getCalendarDateRange(month: Date): string[] {
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = startOfWeek(firstOfMonth, getWeekOptions())
  const dates: string[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    dates.push(formatDate(d))
  }
  return dates
}

/** Derive per-source Date arrays from the by-source agenda data. */
export function computeSourceModifiers(data: Record<string, Record<string, number>>): {
  datesWithDue: Date[]
  datesWithScheduled: Date[]
  datesWithProperty: Date[]
} {
  const datesWithDue: Date[] = []
  const datesWithScheduled: Date[] = []
  const datesWithProperty: Date[] = []
  if (!data || typeof data !== 'object') {
    return { datesWithDue, datesWithScheduled, datesWithProperty }
  }
  for (const [dateStr, sources] of Object.entries(data)) {
    if (!sources || typeof sources !== 'object') continue
    const parts = dateStr.split('-')
    if (parts.length !== 3) continue
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    if ((sources['column:due_date'] ?? 0) > 0) datesWithDue.push(d)
    if ((sources['column:scheduled_date'] ?? 0) > 0) datesWithScheduled.push(d)
    const hasProp = Object.keys(sources).some(
      (k) => k.startsWith('property:') && (sources[k] ?? 0) > 0,
    )
    if (hasProp) datesWithProperty.push(d)
  }
  return { datesWithDue, datesWithScheduled, datesWithProperty }
}

/** Dot color classes in display order: page, due, scheduled, property. */
const DOT_MODIFIERS = [
  { key: 'hasContent', color: 'bg-primary' },
  { key: 'hasDue', color: 'bg-date-due-foreground' },
  { key: 'hasScheduled', color: 'bg-date-scheduled-foreground' },
  { key: 'hasProperty', color: 'bg-date-property-foreground' },
] as const

/** Custom DayButton that renders real DOM dot indicators below the date number. */
function CalendarDayButton({
  day,
  modifiers,
  children,
  className,
  ...props
}: {
  day: CalendarDay
  modifiers: Modifiers
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const dots = DOT_MODIFIERS.filter((d) => modifiers[d.key])

  return (
    <button className={cn(className, 'relative')} {...props}>
      {children}
      {dots.length > 0 && (
        <span
          className="absolute bottom-[2px] left-1/2 flex -translate-x-1/2 gap-[2px] pointer-events-none"
          data-testid="calendar-dots"
        >
          {dots.map((d) => (
            <span
              key={d.key}
              className={cn('h-[5px] w-[5px] rounded-full ring-1 ring-background', d.color)}
              role="img"
              aria-hidden
            />
          ))}
        </span>
      )}
    </button>
  )
}

export interface JournalCalendarDropdownProps {
  currentDate: Date
  highlightedDays: Date[]
  onSelectDate: (day: Date) => void
  onSelectWeek: (dates: Date[]) => void
  onSelectMonth: (month: Date) => void
  onClose: () => void
}

export function JournalCalendarDropdown({
  currentDate,
  highlightedDays,
  onSelectDate,
  onSelectWeek,
  onSelectMonth,
  onClose,
}: JournalCalendarDropdownProps): React.ReactElement {
  const { t } = useTranslation()
  const { weekStartsOn } = useWeekStart()
  const { invalidationKey } = useBlockPropertyEvents()
  const calRef = useRef<HTMLDivElement>(null)
  const [flipAbove, setFlipAbove] = useState(false)
  const [shiftLeft, setShiftLeft] = useState(0)
  const [agendaBySource, setAgendaBySource] = useState<Record<string, Record<string, number>>>({})

  const monthKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: monthKey encodes the month
  useEffect(() => {
    let cancelled = false
    const dates = getCalendarDateRange(currentDate)
    countAgendaBatchBySource({ dates })
      .then((data) => {
        if (!cancelled) setAgendaBySource(data)
      })
      .catch((err: unknown) => {
        logger.warn(
          'JournalCalendarDropdown',
          'Failed to load agenda counts for calendar',
          undefined,
          err,
        )
      })
    return () => {
      cancelled = true
    }
  }, [monthKey, invalidationKey])

  const { datesWithDue, datesWithScheduled, datesWithProperty } = useMemo(
    () => computeSourceModifiers(agendaBySource),
    [agendaBySource],
  )

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
        aria-label={t('journal.datePickerLabel')}
        className={cn(
          'absolute right-0 z-50 rounded-md border bg-popover p-2 shadow-md',
          flipAbove ? 'bottom-full mb-1' : 'top-full mt-1',
        )}
        style={shiftLeft > 0 ? { transform: `translateX(${shiftLeft}px)` } : undefined}
      >
        <Calendar
          mode="single"
          selected={currentDate}
          onSelect={(day) => day && onSelectDate(day)}
          defaultMonth={currentDate}
          weekStartsOn={weekStartsOn}
          showWeekNumber
          showOutsideDays
          onWeekNumberClick={(_wn: number, dates: Date[]) => onSelectWeek(dates)}
          onMonthClick={(month: Date) => onSelectMonth(month)}
          modifiers={{
            hasContent: highlightedDays,
            hasDue: datesWithDue,
            hasScheduled: datesWithScheduled,
            hasProperty: datesWithProperty,
          }}
          components={{ DayButton: CalendarDayButton }}
        />
        {/* Color dot legend */}
        <div
          className="flex flex-wrap items-center gap-3 px-3 pb-2 text-xs text-muted-foreground"
          data-testid="calendar-legend"
        >
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-primary" />
            {t('journal.legendPage')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-date-due-foreground" />
            {t('journal.legendDue')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-date-scheduled-foreground" />
            {t('journal.legendScheduled')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-date-property-foreground" />
            {t('journal.legendProperty')}
          </span>
        </div>
      </div>
    </>
  )
}
