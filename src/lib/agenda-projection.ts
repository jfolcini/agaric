/**
 * Which projected occurrences of repeating tasks Agenda mode lists for its
 * filters (#5735). `list_projected_agenda` answers a date range only, so the
 * other filters are judged here against each occurrence's source block, and a
 * filter that no field of that block can answer (tag, property, completed or
 * created date) hides the projection rather than list occurrences it would
 * exclude.
 */

import { toFutureDatePreset, unionRanges } from '@/lib/agenda-filters'
import type { ActiveProjectedAgendaEntry } from '@/lib/bindings'
import { formatDate, getDateRangeForFilter } from '@/lib/date-utils'
import type { AgendaFilter } from '@/lib/filter-dimension-metadata'

interface DateSpan {
  start: string
  end: string
}

export interface AgendaProjectionPlan extends DateSpan {
  accepts: (entry: ActiveProjectedAgendaEntry) => boolean
}

/**
 * With no due or scheduled filter Agenda mode projects the coming week (today
 * and the six days after), org-agenda's default span.
 */
const DEFAULT_PRESET = 'next-7-days'

/**
 * The part of a due / scheduled filter's span from today on: an occurrence
 * before today is one the task already missed, not one it will have. `null`
 * when the filter selects only `Overdue`.
 */
function futureSpan(values: string[], today: Date): DateSpan | null {
  const ranges: DateSpan[] = []
  for (const value of values) {
    const preset = toFutureDatePreset(value)
    const range = preset ? getDateRangeForFilter(preset, today) : null
    if (range) ranges.push(range)
  }
  const span = unionRanges(ranges)
  if (!span) return null
  const todayStr = formatDate(today)
  return { start: span.start < todayStr ? todayStr : span.start, end: span.end }
}

/**
 * The range to fetch and the predicate an occurrence must pass, or `null` when
 * the filters leave no occurrence to list. Mirrors `translateFilters`
 * (agenda-filters.ts): a filter with no values constrains nothing, and a due or scheduled
 * filter judges the occurrences projected from its own column, leaving out
 * those of the other.
 */
export function planAgendaProjection(
  filters: AgendaFilter[],
  today: Date,
): AgendaProjectionPlan | null {
  const predicates: Array<(entry: ActiveProjectedAgendaEntry) => boolean> = []
  const spans: Partial<Record<'due_date' | 'scheduled_date', DateSpan | null>> = {}
  for (const { dimension, values } of filters) {
    if (values.length === 0) continue
    switch (dimension) {
      case 'status': {
        predicates.push((e) => e.block.todo_state !== null && values.includes(e.block.todo_state))
        break
      }
      case 'priority': {
        predicates.push((e) => e.block.priority !== null && values.includes(e.block.priority))
        break
      }
      case 'dueDate': {
        spans.due_date = futureSpan(values, today)
        break
      }
      case 'scheduledDate': {
        spans.scheduled_date = futureSpan(values, today)
        break
      }
      default: {
        return null
      }
    }
  }

  if (spans.due_date === undefined && spans.scheduled_date === undefined) {
    const week = getDateRangeForFilter(DEFAULT_PRESET, today)
    spans.due_date = week
    spans.scheduled_date = week
  }
  const range = unionRanges(
    [spans.due_date, spans.scheduled_date].filter((s): s is DateSpan => s != null),
  )
  if (!range) return null

  return {
    ...range,
    accepts: (entry) => {
      const span = entry.source === 'due_date' ? spans.due_date : spans.scheduled_date
      if (span == null) return false
      if (entry.projected_date < span.start || entry.projected_date > span.end) return false
      // A `.+` rule can project onto the task's own date, which Agenda mode
      // already lists as the committed task.
      const ownDate =
        entry.source === 'due_date' ? entry.block.due_date : entry.block.scheduled_date
      if (entry.projected_date === ownDate) return false
      return predicates.every((accepts) => accepts(entry))
    },
  }
}
