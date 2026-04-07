import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar } from '@/components/ui/calendar'
import { cn } from '@/lib/utils'
import { formatDate } from '../../lib/date-utils'
import { countAgendaBatchBySource } from '../../lib/tauri'

/** Compute ~42 date strings (6 weeks) for the calendar view centred on the given month. */
function getCalendarDateRange(month: Date): string[] {
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1)
  const dow = firstOfMonth.getDay()
  const startOffset = dow === 0 ? 6 : dow - 1
  const start = new Date(firstOfMonth)
  start.setDate(start.getDate() - startOffset)
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
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [monthKey])

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
          weekStartsOn={1}
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
          modifiersClassNames={{
            hasContent: 'has-content-dot',
            hasDue: 'has-due-dot',
            hasScheduled: 'has-scheduled-dot',
            hasProperty: 'has-property-dot',
          }}
        />
        <style>{`
          .has-content-dot { position: relative; --dot-page: var(--primary); }
          .has-due-dot { position: relative; --dot-due: #ea580c; }
          .has-scheduled-dot { position: relative; --dot-sched: #16a34a; }
          .has-property-dot { position: relative; --dot-prop: #9333ea; }
          .has-content-dot::after,
          .has-due-dot::after,
          .has-scheduled-dot::after,
          .has-property-dot::after {
            content: '';
            position: absolute;
            bottom: 1px;
            left: 50%;
            width: 1px;
            height: 1px;
            border-radius: 50%;
            transform: translateX(-50%);
            pointer-events: none;
            box-shadow:
              -6px 0 0 1.5px var(--dot-page, transparent),
              -2px 0 0 1.5px var(--dot-due, transparent),
              2px 0 0 1.5px var(--dot-sched, transparent),
              6px 0 0 1.5px var(--dot-prop, transparent);
          }
        `}</style>
      </div>
    </>
  )
}
