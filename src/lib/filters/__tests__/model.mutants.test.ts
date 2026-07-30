/**
 * Targeted mutation-kill tests for `src/lib/filters/model.ts` (issue #3142).
 *
 * These call the internal (but exported) singular conversion functions
 * directly — `graphFilterToCanonical` / `canonicalToGraphFilter` — rather than
 * only through the round-trip composition tested in `model.test.ts`. Both
 * functions are exported and document a per-`GraphFilter['type']` /
 * per-`FilterPredicate['kind']` contract, so pinning their direct behaviour is
 * exercising the public contract, not padding coverage.
 *
 * Scope: src/lib/filters/model.ts lines 161, 165, 177, 213, 220, 230, 240,
 * 252, 258, 277 only.
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalToGraphFilter,
  canonicalToGraphFilters,
  type FilterPredicate,
  graphFilterToCanonical,
  graphFiltersToCanonical,
} from '@/lib/filters/model'

// ── lines 161 / 165 — graphHasDateToPredicate (via hasDueDate/hasScheduledDate) ──

describe('graphFilterToCanonical — hasDueDate/hasScheduledDate date-sentinel mapping', () => {
  it('value=true maps to the After sentinel predicate (pins the exact string)', () => {
    // Kills 161 [ObjectLiteral] (would empty the `{ type: 'After', date }`
    // literal to `{}`), 161 [StringLiteral] ('After' -> ''), and 165
    // [StringLiteral] (the GRAPH_HAS_DATE_SENTINEL constant -> '').
    expect(graphFilterToCanonical({ type: 'hasDueDate', value: true })).toEqual({
      kind: 'date',
      field: 'due',
      predicate: { type: 'After', date: '__graph-has-date__' },
    })
    expect(graphFilterToCanonical({ type: 'hasScheduledDate', value: true })).toEqual({
      kind: 'date',
      field: 'scheduled',
      predicate: { type: 'After', date: '__graph-has-date__' },
    })
  })

  it('value=false maps to the IsNull predicate (pins the exact literal, not {})', () => {
    // Kills 161 [ObjectLiteral] on the `{ type: 'IsNull' }` branch and 161
    // [StringLiteral] ('IsNull' -> '').
    expect(graphFilterToCanonical({ type: 'hasDueDate', value: false })).toEqual({
      kind: 'date',
      field: 'due',
      predicate: { type: 'IsNull' },
    })
  })
})

// ── line 177 — graphFilterToCanonical's own `case 'tag'` ─────────────────────

describe('graphFilterToCanonical — direct tag case (line 177)', () => {
  it('projects a single-id tag filter without going through graphFiltersToCanonical', () => {
    // graphFiltersToCanonical special-cases 'tag' and never reaches this
    // switch arm, so it must be exercised directly. Kills the StringLiteral
    // mutant that turns `case 'tag':` into `case '':` — a real 'tag' type
    // would then fall through to no matching arm (implicit `undefined`).
    expect(graphFilterToCanonical({ type: 'tag', tagIds: ['t-work'] })).toEqual({
      kind: 'tag',
      by: 'id',
      tagId: 't-work',
    })
  })

  it('a tag filter with no ids projects an empty tagId (not undefined)', () => {
    expect(graphFilterToCanonical({ type: 'tag', tagIds: [] })).toEqual({
      kind: 'tag',
      by: 'id',
      tagId: '',
    })
  })
})

// ── line 213 — canonicalToGraphFilter's own `case 'tag'` ─────────────────────

describe('canonicalToGraphFilter — direct tag case (line 213)', () => {
  it('projects a by-id tag predicate without going through canonicalToGraphFilters', () => {
    // canonicalToGraphFilters special-cases by:'id' tag predicates and never
    // reaches this switch arm either, so exercise it directly. Kills the
    // StringLiteral mutant `case 'tag':` -> `case '':` (real 'tag' predicates
    // would then hit `default: return null` instead of projecting).
    expect(canonicalToGraphFilter({ kind: 'tag', by: 'id', tagId: 'z' })).toEqual({
      type: 'tag',
      tagIds: ['z'],
    })
  })

  it('a by-name tag predicate is not a graph dimension', () => {
    expect(canonicalToGraphFilter({ kind: 'tag', by: 'name', name: 'work' })).toBeNull()
  })
})

// ── line 220 — status isNull/exclude guard ───────────────────────────────────

describe('canonicalToGraphFilter — status isNull/exclude guard (line 220)', () => {
  it('a plain membership status predicate (both flags false) projects to graph', () => {
    // Kills the ConditionalExpression forced-true mutant: with both flags
    // false this must NOT collapse to null.
    expect(
      canonicalToGraphFilter({ kind: 'status', values: ['TODO'], isNull: false, exclude: false }),
    ).toEqual({ type: 'status', values: ['TODO'] })
  })

  it('isNull=true alone is graph-inexpressible (not a graph filter)', () => {
    // Kills the ConditionalExpression forced-false mutant (this case would
    // wrongly project) and the LogicalOperator `||` -> `&&` mutant (under
    // `&&`, isNull alone — with exclude false — would NOT trigger null).
    expect(
      canonicalToGraphFilter({ kind: 'status', values: ['TODO'], isNull: true, exclude: false }),
    ).toBeNull()
  })

  it('exclude=true alone is also graph-inexpressible', () => {
    // Same LogicalOperator direction as above, exercised from the other arm:
    // under `&&`, exclude alone (isNull false) would also NOT trigger null.
    expect(
      canonicalToGraphFilter({ kind: 'status', values: ['TODO'], isNull: false, exclude: true }),
    ).toBeNull()
  })
})

// ── line 230 — date field === 'scheduled' guard ──────────────────────────────

describe('canonicalToGraphFilter — date field routing (line 230)', () => {
  it('a scheduled-field date predicate projects to hasScheduledDate', () => {
    // Kills the ConditionalExpression forced-false mutant: a real
    // field:'scheduled' predicate must still project.
    expect(
      canonicalToGraphFilter({
        kind: 'date',
        field: 'scheduled',
        predicate: { type: 'After', date: '__graph-has-date__' },
      }),
    ).toEqual({ type: 'hasScheduledDate', value: true })
  })

  it('a created-field date predicate is NOT a graph dimension (not scheduled)', () => {
    // Kills the ConditionalExpression forced-true mutant: forcing this guard
    // true would wrongly treat a 'created'-field predicate as hasScheduledDate.
    expect(
      canonicalToGraphFilter({
        kind: 'date',
        field: 'created',
        predicate: { type: 'IsNull' },
      }),
    ).toBeNull()
  })

  it('a lastEdited-field date predicate is also NOT a graph dimension', () => {
    expect(
      canonicalToGraphFilter({
        kind: 'date',
        field: 'lastEdited',
        predicate: { type: 'IsNull' },
      }),
    ).toBeNull()
  })
})

// ── line 240 — default arm of the canonicalToGraphFilter switch ─────────────

describe('canonicalToGraphFilter — default arm (line 240)', () => {
  it('returns null (not undefined) for pages-only predicates with no graph dimension', () => {
    // Kills the BlockStatement mutant that empties `default: { return null }`
    // to `default: {}` (implicit `undefined`) — `toBe(null)` distinguishes
    // undefined from null, unlike a loose falsy check.
    expect(canonicalToGraphFilter({ kind: 'orphan' })).toBe(null)
    expect(canonicalToGraphFilter({ kind: 'stub' })).toBe(null)
    expect(canonicalToGraphFilter({ kind: 'contains', query: 'hello' })).toBe(null)
  })
})

// ── line 252 — graphFiltersToCanonical's accumulator seed ───────────────────

describe('graphFiltersToCanonical — accumulator starts empty (line 252)', () => {
  it('an empty filter list projects to an empty canonical list, not a seeded one', () => {
    // Kills the ArrayDeclaration mutant that seeds `out` with a placeholder
    // element instead of `[]` — the loop never runs, so the seed would leak
    // straight through to the return value.
    expect(graphFiltersToCanonical([])).toEqual([])
  })
})

// ── line 258 — empty-tagIds no-op preservation ──────────────────────────────

describe('graphFiltersToCanonical — empty-tagIds no-op preservation (line 258)', () => {
  it('an empty-id tag filter is preserved as one empty-id canonical tag entry', () => {
    // Kills the ConditionalExpression forced-false mutant: dropping this
    // push would silently discard the no-op filter instead of preserving it.
    expect(graphFiltersToCanonical([{ type: 'tag', tagIds: [] }])).toEqual([
      { kind: 'tag', by: 'id', tagId: '' },
    ])
  })

  it('a non-empty tag filter produces exactly one canonical entry per id (no spurious extra)', () => {
    // Kills the ConditionalExpression forced-true mutant: pushing the
    // empty-id placeholder unconditionally would append a spurious extra
    // entry even though tagIds is non-empty.
    expect(graphFiltersToCanonical([{ type: 'tag', tagIds: ['a'] }])).toEqual([
      { kind: 'tag', by: 'id', tagId: 'a' },
    ])
  })
})

// ── line 277 — canonicalToGraphFilters' tag-collection guard ────────────────

describe('canonicalToGraphFilters — tag-collection guard (line 277)', () => {
  it('a by-name tag predicate is neither collected into tagIds nor projected', () => {
    // Kills the ConditionalExpression forced-true mutant (would wrongly
    // enter the tag-collection branch for a by:'name' predicate, whose
    // `.tagId` is undefined, producing a bogus `tagIds: [undefined]` entry)
    // and the LogicalOperator `&&` -> `||` mutant (same wrong branch, since
    // `kind === 'tag'` alone is already true for a by:'name' predicate).
    const predicates: FilterPredicate[] = [{ kind: 'tag', by: 'name', name: 'work' }]
    expect(canonicalToGraphFilters(predicates)).toEqual([])
  })

  it('a by-id tag predicate alone collapses to a single graph tag filter', () => {
    const predicates: FilterPredicate[] = [{ kind: 'tag', by: 'id', tagId: 'z' }]
    expect(canonicalToGraphFilters(predicates)).toEqual([{ type: 'tag', tagIds: ['z'] }])
  })

  it('two by-id tag predicates merge into ONE multi-id tag filter, unshifted first', () => {
    // Kills the ConditionalExpression forced-false direction, which is
    // otherwise invisible with a single tag predicate: `canonicalToGraphFilter`
    // has its own fallback `case 'tag'` arm that also produces a valid
    // `{ type: 'tag', tagIds: [id] }` for a lone by:'id' predicate, so a
    // single-tag test can't tell "merged via the collection branch" from
    // "individually converted via the per-predicate fallback". Two tag
    // predicates plus a non-tag predicate can: real behaviour merges both ids
    // into one filter and unshifts it to the front; the forced-false mutant
    // instead falls through to the per-predicate fallback, producing two
    // separate single-id tag filters in encounter order (status filter first).
    const predicates: FilterPredicate[] = [
      { kind: 'status', values: ['TODO'], isNull: false, exclude: false },
      { kind: 'tag', by: 'id', tagId: 'x' },
      { kind: 'tag', by: 'id', tagId: 'y' },
    ]
    expect(canonicalToGraphFilters(predicates)).toEqual([
      { type: 'tag', tagIds: ['x', 'y'] },
      { type: 'status', values: ['TODO'] },
    ])
  })
})
