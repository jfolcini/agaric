/**
 * RelativeTime — "3h ago" that swaps in place to the exact date and time.
 *
 * The exact time used to sit in a hover tooltip on an unfocusable span, so
 * phone and keyboard users only ever saw "3h ago" (#6895). This is a small
 * button: a tap, click, Enter or Space swaps it to the exact date and time,
 * and again back. The swap is announced, since the button's name is its text.
 *
 * It sits inside selectable rows (History), so a press on it does not reach
 * the row.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatTimestamp } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'

export interface RelativeTimeProps {
  /** ISO 8601 string or epoch milliseconds. */
  value: string | number
  /** From `useMinuteClock`, so the relative label ages. */
  now?: number
  className?: string
}

export function RelativeTime({ value, now, className }: RelativeTimeProps): React.ReactElement {
  const { t } = useTranslation()
  const [exact, setExact] = useState(false)
  const date = new Date(value)
  return (
    <button
      type="button"
      data-slot="relative-time"
      aria-live="polite"
      className={cn(
        'w-fit bg-transparent p-0 text-xs text-muted-foreground tabular-nums cursor-pointer hover:text-foreground touch-hit-area focus-ring-visible',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation()
        setExact((v) => !v)
      }}
    >
      <time {...(Number.isNaN(date.getTime()) ? {} : { dateTime: date.toISOString() })}>
        {exact ? formatTimestamp(value, 'full') : formatRelativeTime(value, t, now)}
      </time>
    </button>
  )
}
