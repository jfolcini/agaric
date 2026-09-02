/**
 * Exhaustiveness guards for the add-filter predicate-op tables (#2243, widened
 * #4553 Phase 1).
 *
 * `DATE_OPS`, `ALL_PROPERTY_OPS` and `PROPERTY_OP_ARITY` are hand-maintained
 * enumerations of the generated `DatePredicate` / `PropertyPredicate` union
 * members. Before these tests, a new predicate variant could be added to the
 * Rust bindings and the corresponding op would silently vanish from the UI
 * with the whole suite still green.
 *
 * `DATE_OPS` and `ALL_PROPERTY_OPS` are each exhaustive over their bindings
 * union (every variant is listed). `PROPERTY_OPS`, by contrast, deliberately
 * surfaces only a SUBSET of `ALL_PROPERTY_OPS` — the classic 4-operator set
 * the Pages browser's `+ Filter` popover has always offered (#4553 acceptance
 * criterion 7). The advanced surface derives its own (wider, type-driven)
 * subset via `propertyOpsForValueType`, which keys on the DECLARED
 * `value_type` and delegates to `propertyOpsForValueKind` for every type but
 * `boolean` (#4571 item 2) — both tested separately below.
 *
 * Two layers of protection:
 *   1. Compile-time — the `satisfies Record<…Kind, …>` completeness records
 *      fail to type-check (`tsc -b`) the moment a bindings variant is added
 *      without being classified below.
 *   2. Runtime — the union-equality assertions fail if the op TABLE the UI
 *      renders from drifts from its classification (a surfaced variant
 *      dropped, a duplicate row, an arity mismatch).
 */

import { describe, expect, it } from 'vitest'

import {
  ALL_PROPERTY_OPS,
  DATE_OPS,
  type DateOpKind,
  PROPERTY_OP_ARITY,
  PROPERTY_OPS,
  PROPERTY_OPS_BY_VALUE_KIND,
  type PropertyOpKind,
  propertyOpsForValueKind,
  propertyOpsForValueType,
  propertyValueKindForType,
  type PropertyValueKind,
  TODO_STATE_VALUES,
  VALUE_BEARING_OPS,
} from '@/components/PageBrowser/add-filter/vocab'
import { TASK_STATES } from '@/lib/task-states'

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

// Every PropertyPredicate variant (#4553 Phase 1 widened this from 4 to all
// 10) — `ALL_PROPERTY_OPS` must be exhaustive over this.
const ALL_PROPERTY_OP_KINDS = {
  Eq: true,
  Ne: true,
  Lt: true,
  Gt: true,
  Lte: true,
  Gte: true,
  Contains: true,
  StartsWith: true,
  Exists: true,
  NotExists: true,
} satisfies Record<PropertyOpKind, true>

// PropertyPredicate variants the PAGES BROWSER surfaces — this must match
// `PROPERTY_OPS` (asserted at runtime below). Unchanged since #1648/D24;
// #4553 acceptance criterion 7 requires this to stay exactly this set.
const SURFACED_PROPERTY_OPS = {
  Eq: true,
  Ne: true,
  Exists: true,
  NotExists: true,
} satisfies Partial<Record<PropertyOpKind, true>>

// The nullary (no-value) PropertyPredicate variants — every other variant is
// unary (carries a `PropertyValue`). Must match `PROPERTY_OP_ARITY`.
const NULLARY_OPS = {
  Exists: true,
  NotExists: true,
} satisfies Partial<Record<PropertyOpKind, true>>

describe('add-filter vocab op tables — exhaustiveness', () => {
  it('uses the canonical task states by identity and in filter order', () => {
    expect(TODO_STATE_VALUES).toBe(TASK_STATES)
    expect(TODO_STATE_VALUES).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED'])
  })

  it('DATE_OPS covers every DatePredicate variant exactly once', () => {
    const values = DATE_OPS.map((o) => o.value)
    expect(new Set(values)).toEqual(new Set(Object.keys(ALL_DATE_OPS)))
    // No duplicate rows.
    expect(values).toHaveLength(new Set(values).size)
  })

  it('ALL_PROPERTY_OPS covers every PropertyPredicate variant exactly once', () => {
    const values = ALL_PROPERTY_OPS.map((o) => o.value)
    expect(new Set(values)).toEqual(new Set(Object.keys(ALL_PROPERTY_OP_KINDS)))
    expect(values).toHaveLength(new Set(values).size)
    expect(values).toHaveLength(10)
  })

  // #4553 acceptance criterion 7 — the Pages browser's classic 4-op subset
  // must stay pinned to Eq/Ne/Exists/NotExists no matter how wide
  // `ALL_PROPERTY_OPS` grows.
  it('PROPERTY_OPS surfaces exactly the classic Pages-browser 4-operator subset', () => {
    const values = PROPERTY_OPS.map((o) => o.value)
    expect(new Set(values)).toEqual(new Set(Object.keys(SURFACED_PROPERTY_OPS)))
    expect(values).toHaveLength(new Set(values).size)
    // Order is load-bearing for the rendered <select>: Eq, Ne, Exists, NotExists.
    expect(values).toEqual(['Eq', 'Ne', 'Exists', 'NotExists'])
  })

  // #4553 Phase 1 — VALUE_BEARING_OPS is now DERIVED from PROPERTY_OP_ARITY,
  // not a hand-maintained Eq/Ne allow-list: every operator except
  // Exists/NotExists carries a value.
  it('PROPERTY_OP_ARITY classifies every operator as nullary xor unary', () => {
    for (const op of Object.keys(ALL_PROPERTY_OP_KINDS) as PropertyOpKind[]) {
      const expected = Object.hasOwn(NULLARY_OPS, op) ? 'nullary' : 'unary'
      expect(PROPERTY_OP_ARITY[op]).toBe(expected)
    }
  })

  it('VALUE_BEARING_OPS equals every unary (non-Exists/NotExists) operator', () => {
    const expectedValueBearing = (Object.keys(ALL_PROPERTY_OP_KINDS) as PropertyOpKind[]).filter(
      (op) => !Object.hasOwn(NULLARY_OPS, op),
    )
    expect(VALUE_BEARING_OPS).toEqual(new Set(expectedValueBearing))
    expect(VALUE_BEARING_OPS.size).toBe(8)
    // In particular — the whole point of #4553's fix — Lt/Gt/Lte/Gte/
    // Contains/StartsWith are value-bearing, not just Eq/Ne.
    for (const op of ['Lt', 'Gt', 'Lte', 'Gte', 'Contains', 'StartsWith'] as const) {
      expect(VALUE_BEARING_OPS.has(op)).toBe(true)
    }
    expect(VALUE_BEARING_OPS.has('Exists')).toBe(false)
    expect(VALUE_BEARING_OPS.has('NotExists')).toBe(false)
  })
})

// ── #4553 Phase 1 — tiered exposure by declared value_type ─────────────────

describe('PROPERTY_OPS_BY_VALUE_KIND / propertyOpsForValueKind', () => {
  it('offers exactly the 8 ordered-comparison-capable ops for Num', () => {
    expect(PROPERTY_OPS_BY_VALUE_KIND.Num).toEqual([
      'Eq',
      'Ne',
      'Lt',
      'Lte',
      'Gt',
      'Gte',
      'Exists',
      'NotExists',
    ])
    expect(propertyOpsForValueKind('Num').map((o) => o.value)).toEqual(
      PROPERTY_OPS_BY_VALUE_KIND.Num,
    )
  })

  it('offers exactly the 8 ordered-comparison-capable ops for Date', () => {
    expect(PROPERTY_OPS_BY_VALUE_KIND.Date).toEqual([
      'Eq',
      'Ne',
      'Lt',
      'Lte',
      'Gt',
      'Gte',
      'Exists',
      'NotExists',
    ])
    expect(propertyOpsForValueKind('Date').map((o) => o.value)).toEqual(
      PROPERTY_OPS_BY_VALUE_KIND.Date,
    )
  })

  it('offers Eq/Ne/Contains/StartsWith/Exists/NotExists for Text — no ordered comparisons', () => {
    expect(PROPERTY_OPS_BY_VALUE_KIND.Text).toEqual([
      'Eq',
      'Ne',
      'Contains',
      'StartsWith',
      'Exists',
      'NotExists',
    ])
    expect(propertyOpsForValueKind('Text').map((o) => o.value)).toEqual(
      PROPERTY_OPS_BY_VALUE_KIND.Text,
    )
    // Never a lexical footgun: Lt/Gt/Lte/Gte must be absent for Text.
    for (const op of ['Lt', 'Gt', 'Lte', 'Gte'] as const) {
      expect(PROPERTY_OPS_BY_VALUE_KIND.Text).not.toContain(op)
    }
  })

  it('offers only Eq/Ne/Exists/NotExists for Ref — no Contains/StartsWith either', () => {
    expect(PROPERTY_OPS_BY_VALUE_KIND.Ref).toEqual(['Eq', 'Ne', 'Exists', 'NotExists'])
    expect(propertyOpsForValueKind('Ref').map((o) => o.value)).toEqual(
      PROPERTY_OPS_BY_VALUE_KIND.Ref,
    )
  })

  it('every offered op is drawn from ALL_PROPERTY_OPS (labels never drift)', () => {
    const allLabels = new Map(ALL_PROPERTY_OPS.map((o) => [o.value, o.labelKey]))
    for (const kind of ['Num', 'Date', 'Text', 'Ref'] as const) {
      for (const op of propertyOpsForValueKind(kind)) {
        expect(op.labelKey).toBe(allLabels.get(op.value))
      }
    }
  })
})

describe('propertyValueKindForType', () => {
  it.each<[string | null | undefined, PropertyValueKind]>([
    ['number', 'Num'],
    ['date', 'Date'],
    ['ref', 'Ref'],
    ['text', 'Text'],
    ['select', 'Text'],
    // `boolean` has no `PropertyValue` variant, so this is a placeholder, not
    // a comparison the UI ever builds: `propertyOpsForValueType` offers a
    // boolean-declared key `Exists`/`NotExists` only (#4571 item 2), and
    // neither reads a value column.
    ['boolean', 'Text'],
    // Undeclared key (no registry entry) — the bare-text-box default.
    [null, 'Text'],
    [undefined, 'Text'],
    // An unrecognised string must not throw or silently pick a wrong variant.
    ['bogus', 'Text'],
  ])('maps declared value_type %j to %s', (valueType, expected) => {
    expect(propertyValueKindForType(valueType)).toBe(expected)
  })
})

// This function exists because the operator question and the
// `PropertyValue`-variant question disagree for exactly one declared type
// (see `propertyOpsForValueType`), so both arms are pinned: the boolean one
// and the delegation.
describe('propertyOpsForValueType (#4571 item 2)', () => {
  it('offers a boolean-declared key existence only', () => {
    expect(propertyOpsForValueType('boolean').map((o) => o.value)).toEqual(['Exists', 'NotExists'])
  })

  // The half that makes the boolean arm mean something: `boolean` and `text`
  // map to the SAME `PropertyValueKind`, so a function that merely forwarded
  // to `propertyOpsForValueKind` would return the identical list for both.
  it('does not give a boolean-declared key the Text tier it maps to', () => {
    expect(propertyOpsForValueType('boolean').map((o) => o.value)).not.toEqual(
      propertyOpsForValueKind(propertyValueKindForType('boolean')).map((o) => o.value),
    )
  })

  it.each<[string | null | undefined, PropertyValueKind]>([
    ['number', 'Num'],
    ['date', 'Date'],
    ['ref', 'Ref'],
    ['text', 'Text'],
    ['select', 'Text'],
    // An UNDECLARED key keeps the bare-text-box tier it has always had — the
    // gap #4571 deliberately left open (item 3, out of scope).
    [null, 'Text'],
    [undefined, 'Text'],
    ['bogus', 'Text'],
  ])('delegates value_type %j to the %s tier unchanged', (valueType, kind) => {
    expect(propertyOpsForValueType(valueType)).toEqual(propertyOpsForValueKind(kind))
  })

  it('every op it offers is drawn from ALL_PROPERTY_OPS (labels never drift)', () => {
    const allLabels = new Map(ALL_PROPERTY_OPS.map((o) => [o.value, o.labelKey]))
    for (const valueType of ['boolean', 'number', 'date', 'ref', 'text', null]) {
      for (const op of propertyOpsForValueType(valueType)) {
        expect(op.labelKey).toBe(allLabels.get(op.value))
      }
    }
  })
})
