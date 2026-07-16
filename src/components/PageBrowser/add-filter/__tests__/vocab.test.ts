/**
 * Exhaustiveness guards for the add-filter predicate-op tables (#2243).
 *
 * `DATE_OPS`, `PROPERTY_OPS` and `VALUE_BEARING_OPS` are hand-maintained
 * enumerations of the generated `DatePredicate` / `PropertyPredicate` union
 * members. Before these tests, a new predicate variant could be added to the
 * Rust bindings and the corresponding op would silently vanish from the UI
 * with the whole suite still green.
 *
 * `DATE_OPS` is exhaustive over `DatePredicate` (every variant is offered).
 * `PROPERTY_OPS`, by contrast, deliberately surfaces only a SUBSET of the ten
 * `PropertyPredicate` variants — the comparison ops (`Lt`/`Gt`/`Lte`/`Gte`/
 * `Contains`/`StartsWith`) exist on the wire but aren't offered in this
 * popover. So the guard here isn't "the table lists every variant" but "every
 * variant is consciously classified as either surfaced or not-surfaced".
 *
 * Two layers of protection:
 *   1. Compile-time — the `satisfies Record<…Kind, true>` completeness records
 *      fail to type-check (`tsc -b`) the moment a bindings variant is added
 *      without being classified below.
 *   2. Runtime — the union-equality assertions fail if the op TABLE the UI
 *      renders from drifts from its classification (a surfaced variant dropped
 *      from `PROPERTY_OPS`, a duplicate row, a value-bearing mismatch).
 */

import { describe, expect, it } from 'vitest'

import {
  DATE_OPS,
  type DateOpKind,
  PROPERTY_OPS,
  type PropertyOpKind,
  VALUE_BEARING_OPS,
} from '@/components/PageBrowser/add-filter/vocab'

// Compile-time exhaustiveness: must name every DatePredicate variant.
const ALL_DATE_OPS = {
  IsNull: true,
  Before: true,
  After: true,
  OnOrBefore: true,
  OnOrAfter: true,
  On: true,
  Between: true,
} satisfies Record<DateOpKind, true>

// PropertyPredicate variants surfaced by the add-filter popover — this must
// match `PROPERTY_OPS` (asserted at runtime below).
const SURFACED_PROPERTY_OPS = {
  Eq: true,
  Ne: true,
  Exists: true,
  NotExists: true,
} satisfies Partial<Record<PropertyOpKind, true>>

// PropertyPredicate variants that exist on the wire but are intentionally NOT
// offered in this popover (comparison / substring ops).
const NOT_SURFACED_PROPERTY_OPS = {
  Lt: true,
  Gt: true,
  Lte: true,
  Gte: true,
  Contains: true,
  StartsWith: true,
} satisfies Partial<Record<PropertyOpKind, true>>

// Compile-time exhaustiveness: surfaced ∪ not-surfaced must cover the whole
// PropertyPredicate union. A new bindings variant breaks this until it is
// classified into one of the two buckets above.
const ALL_PROPERTY_OPS = {
  ...SURFACED_PROPERTY_OPS,
  ...NOT_SURFACED_PROPERTY_OPS,
} satisfies Record<PropertyOpKind, true>

// The surfaced ops that carry a value operand (the value input is required).
const VALUE_BEARING = {
  Eq: true,
  Ne: true,
} satisfies Partial<Record<PropertyOpKind, true>>

describe('add-filter vocab op tables — exhaustiveness', () => {
  it('DATE_OPS covers every DatePredicate variant exactly once', () => {
    const values = DATE_OPS.map((o) => o.value)
    expect(new Set(values)).toEqual(new Set(Object.keys(ALL_DATE_OPS)))
    // No duplicate rows.
    expect(values).toHaveLength(new Set(values).size)
  })

  it('PROPERTY_OPS surfaces exactly the surfaced-classified variants', () => {
    const values = PROPERTY_OPS.map((o) => o.value)
    expect(new Set(values)).toEqual(new Set(Object.keys(SURFACED_PROPERTY_OPS)))
    expect(values).toHaveLength(new Set(values).size)
  })

  it('surfaced and not-surfaced property ops are disjoint and cover the union', () => {
    const surfaced = Object.keys(SURFACED_PROPERTY_OPS)
    const notSurfaced = Object.keys(NOT_SURFACED_PROPERTY_OPS)
    // Disjoint.
    for (const op of surfaced) expect(notSurfaced).not.toContain(op)
    // Cover the full union with no overlap (lengths add up).
    expect(surfaced.length + notSurfaced.length).toBe(Object.keys(ALL_PROPERTY_OPS).length)
  })

  it('VALUE_BEARING_OPS equals the value-bearing surfaced variants', () => {
    expect(VALUE_BEARING_OPS).toEqual(new Set(Object.keys(VALUE_BEARING)))
    // Value-bearing ops must themselves be surfaced.
    for (const op of VALUE_BEARING_OPS) {
      expect(Object.keys(SURFACED_PROPERTY_OPS)).toContain(op)
    }
  })
})
