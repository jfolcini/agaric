/**
 * The row order a Markdown table's "Sort ascending / descending" writes (#6607). A
 * table has nowhere to store a sort, so the sort is this one-time order of its body
 * rows, read from one column's cell texts.
 */

export type SortDirection = 'asc' | 'desc'

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** `numeric`: "item 9" before "item 10", as people read a mixed column. */
const TEXT = new Intl.Collator(undefined, { numeric: true })

/** A date alone is local midnight, as a zoneless date-time is; `Date.parse` reads it as UTC. */
const dateValue = (c: string) => Date.parse(c.length === 10 ? `${c}T00:00` : c)

/** How every non-empty cell compares: as numbers or dates when all are one, else as text. */
function comparatorFor(cells: readonly string[]): (a: string, b: string) => number {
  if (cells.every((c) => NUMBER.test(c))) return (a, b) => Number(a) - Number(b)
  if (cells.every((c) => ISO_DATE.test(c) && !Number.isNaN(dateValue(c)))) {
    return (a, b) => dateValue(a) - dateValue(b)
  }
  return (a, b) => TEXT.compare(a, b)
}

/**
 * The indices of `cells` in sorted order. Empty cells go last in both directions, and
 * tied cells keep their order (`toSorted` is stable).
 */
export function sortedRowOrder(cells: readonly string[], direction: SortDirection): number[] {
  const trimmed = cells.map((c) => c.trim())
  const compare = comparatorFor(trimmed.filter((c) => c !== ''))
  const sign = direction === 'asc' ? 1 : -1
  return trimmed
    .map((_, i) => i)
    .toSorted((i, j) => {
      const a = trimmed[i] as string
      const b = trimmed[j] as string
      if (a === '' || b === '') return Number(a === '') - Number(b === '')
      return sign * compare(a, b)
    })
}
