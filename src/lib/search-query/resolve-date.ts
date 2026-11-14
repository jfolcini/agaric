import type { DatePredicate } from '@/lib/bindings'
import type { NamedDateRange } from '@/lib/search-query/types'

/**
 * `resolve_named_range` (`agaric-store/src/fts/metadata_filter.rs`) composed
 * with `meta_date_to_primitive`: a date bucket as the predicate search runs for
 * it on `today`, `null` for a name that is no bucket. `today` is read in local
 * time, as `chrono::Local` reads it; weeks run Monday to Sunday.
 */
export function resolveNamedDate(name: string, today: Date): DatePredicate | null {
  const iso = (d: Date): string =>
    `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const shifted = (days: number): Date => {
    const d = new Date(today)
    d.setDate(d.getDate() + days)
    return d
  }
  const between = (from: Date, to: Date): DatePredicate => ({
    type: 'Between',
    from: iso(from),
    to: iso(to),
  })
  // JS weeks start on Sunday.
  const monday = -((today.getDay() + 6) % 7)
  switch (name as NamedDateRange) {
    case 'none': {
      return { type: 'IsNull' }
    }
    case 'today': {
      return between(today, today)
    }
    case 'yesterday': {
      return between(shifted(-1), shifted(-1))
    }
    case 'overdue': {
      return { type: 'Before', date: iso(today) }
    }
    case 'older': {
      return { type: 'Before', date: iso(shifted(-30)) }
    }
    case 'this-week': {
      return between(shifted(monday), shifted(monday + 6))
    }
    case 'next-week': {
      return between(shifted(monday + 7), shifted(monday + 13))
    }
    case 'this-month': {
      return between(
        new Date(today.getFullYear(), today.getMonth(), 1),
        new Date(today.getFullYear(), today.getMonth() + 1, 0),
      )
    }
    default: {
      return null
    }
  }
}
