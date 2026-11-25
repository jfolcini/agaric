/**
 * DateChip — the one drawing of a due or a scheduled date (#7040): on a
 * block, in a task row and as a day's count in the Week headers.
 *
 * Each kind has one glyph (`DATE_ICONS`) and one colour. A due date is red
 * once past, amber today and neutral later (`dueDateColor`); a scheduled date
 * is never late, so it keeps the scheduled colour whatever its day. An overdue
 * date also fills its flag, so the state does not rest on colour alone.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { DATE_ICONS } from '@/lib/date-icons'
import { dueDateColor, formatCompactDate, getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'

export type DateKind = keyof typeof DATE_ICONS

const KIND = {
  due: { chipClass: 'due-date-chip', labelKey: 'block.dueDate' },
  scheduled: { chipClass: 'scheduled-chip', labelKey: 'block.scheduledDate' },
} as const satisfies Record<DateKind, { chipClass: string; labelKey: string }>

const DUE_COLOR = 'bg-date-due text-date-due-foreground'
const SCHEDULED_COLOR = 'bg-date-scheduled text-date-scheduled-foreground'

interface DateChipProps extends Omit<React.ComponentProps<'button'>, 'type'> {
  kind: DateKind
  /** The day, YYYY-MM-DD: the chip's text, and what colours a due date. */
  date?: string | undefined
  /** Replaces the date as the chip's text (a count); name it with `aria-label`. */
  children?: React.ReactNode
}

/** A button when it is given an `onClick` (a picker's trigger passes one), text otherwise. */
export function DateChip({
  kind,
  date,
  children,
  className,
  onClick,
  ...props
}: DateChipProps): React.ReactElement {
  const { t } = useTranslation()
  const Icon = DATE_ICONS[kind]
  const { chipClass, labelKey } = KIND[kind]
  const compact = date === undefined ? undefined : formatCompactDate(date)
  const label = compact === undefined ? undefined : t(labelKey, { date: compact })
  const overdue = kind === 'due' && date !== undefined && date < getTodayString()
  const color =
    kind === 'scheduled' ? SCHEDULED_COLOR : date === undefined ? DUE_COLOR : dueDateColor(date)
  const classes = cn(
    chipClass,
    'inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-xs font-medium leading-none tabular-nums select-none',
    color,
    className,
  )
  const icon = (
    <Icon
      // The chip pins text-xs, where 1em stays 12px at every font size, so its
      // icon sizes from the setting itself (#5369).
      className="size-[calc(var(--agaric-font-size,1rem)*0.875)] flex-shrink-0"
      fill={overdue ? 'currentColor' : 'none'}
      aria-hidden="true"
    />
  )
  if (!onClick) {
    return (
      <span className={classes} data-date-kind={kind}>
        {icon}
        {children ?? (
          <>
            <time dateTime={date} aria-hidden="true">
              {compact}
            </time>
            <span className="sr-only">{label}</span>
          </>
        )}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cn(
        classes,
        'touch-hit-area cursor-pointer hover:ring-1 hover:ring-ring focus-ring-visible',
      )}
      data-date-kind={kind}
      aria-label={label}
      onClick={onClick}
      {...props}
    >
      {icon}
      {children ?? <time dateTime={date}>{compact}</time>}
    </button>
  )
}
