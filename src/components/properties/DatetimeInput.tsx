/**
 * DatetimeInput — the editor of a `datetime` value (#6758): the date input
 * the date editors use (natural language, with its preview) and a native
 * time input, both in the device's time zone. Once both read, leaving either
 * or pressing Enter commits the canonical UTC value (`localPartsToDatetime`)
 * when it differs from `value`.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { useDateInput } from '@/hooks/useDateInput'
import { datetimeToLocalParts, localPartsToDatetime } from '@/lib/datetime-value'
import { parseDate } from '@/lib/parse-date'
import { isIsoDate } from '@/lib/search-query/is-iso-date'

export interface DatetimeInputProps {
  /** The canonical value, or null for none. */
  value: string | null
  /** The value's name; each input's label adds which part it is. */
  ariaLabel: string
  /** A promise resolving `true` clears both fields, for the next value. */
  onCommit: (canonical: string) => void | Promise<boolean>
  /** A write is running: the fields turn read-only, not disabled, so they keep the focus (#6912). */
  busy?: boolean | undefined
}

/** The day a date input's text names, or null. */
function dayOf(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return isIsoDate(trimmed) ? trimmed : parseDate(trimmed)
}

export function DatetimeInput({
  value,
  ariaLabel,
  onCommit,
  busy,
}: DatetimeInputProps): React.ReactElement {
  const { t } = useTranslation()
  const parts = value === null ? { date: '', time: '' } : datetimeToLocalParts(value)
  const [time, setTime] = useState(parts.time)
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- resyncs the time draft to a new saved value, as `useDateInput` does the date's; see #4407
    setTime(parts.time)
  }, [parts.time])

  const commit = (day: string | null, at: string): void => {
    if (day === null) return
    const canonical = localPartsToDatetime(day, at)
    if (canonical === null || canonical === value) return
    void onCommit(canonical)?.then((written) => {
      if (!written) return
      setDateInput('')
      setTime('')
    })
  }
  const { dateInput, setDateInput, datePreview, handleChange, handleBlur } = useDateInput({
    initialValue: parts.date,
    onSave: (day) => commit(day === '' ? null : day, time),
  })
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>, run: () => void): void => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    run()
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <Input
          className="h-7 min-w-24 flex-1 text-xs"
          type="text"
          value={dateInput}
          placeholder={t('property.datePlaceholder')}
          readOnly={busy}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={(e) => onEnter(e, handleBlur)}
          aria-label={t('property.datetimeDateLabel', { label: ariaLabel })}
        />
        <Input
          className="h-7 w-auto shrink-0 text-xs"
          type="time"
          value={time}
          readOnly={busy}
          onChange={(e) => setTime(e.target.value)}
          onBlur={() => commit(dayOf(dateInput), time)}
          onKeyDown={(e) => onEnter(e, () => commit(dayOf(dateInput), time))}
          aria-label={t('property.datetimeTimeLabel', { label: ariaLabel })}
        />
      </div>
      {datePreview && <p className="mt-0.5 text-xs text-muted-foreground">{datePreview}</p>}
    </div>
  )
}
