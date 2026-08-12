/**
 * Canonical filter model — Issue #1646 (scoped down by #2258).
 *
 * The Graph surface is the sole runtime consumer of the canonical model: it
 * canonicalises its `GraphFilter[]` and reconstructs it losslessly. These
 * tests are the load-bearing guarantee of that round trip
 * (graph → canonical → graph). The backlink / Pages / search converter
 * families were removed in #2258 (they backed no-op identity round-trips), so
 * their round-trip tests were removed with them.
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalToGraphFilter,
  canonicalToGraphFilters,
  type FilterPredicate,
  graphFilterToCanonical,
  graphFiltersToCanonical,
} from '@/lib/filters/model'
import type { GraphFilter } from '@/lib/graph-filters'

// ---------------------------------------------------------------------------
// Graph surface — lossless ROUND TRIP (the sole live consumer surface).
// ---------------------------------------------------------------------------

describe('graph surface round-trip (canonical ⇄ GraphFilter)', () => {
  const cases: { name: string; filters: GraphFilter[] }[] = [
    { name: 'status (multi)', filters: [{ type: 'status', values: ['TODO', 'DOING'] }] },
    { name: 'priority (multi)', filters: [{ type: 'priority', values: ['1', '2'] }] },
    { name: 'hasDueDate true', filters: [{ type: 'hasDueDate', value: true }] },
    { name: 'hasDueDate false', filters: [{ type: 'hasDueDate', value: false }] },
    { name: 'hasScheduledDate true', filters: [{ type: 'hasScheduledDate', value: true }] },
    { name: 'hasScheduledDate false', filters: [{ type: 'hasScheduledDate', value: false }] },
    { name: 'hasBacklinks true', filters: [{ type: 'hasBacklinks', value: true }] },
    { name: 'hasBacklinks false', filters: [{ type: 'hasBacklinks', value: false }] },
    { name: 'excludeTemplates', filters: [{ type: 'excludeTemplates', value: true }] },
    { name: 'tag (single id)', filters: [{ type: 'tag', tagIds: ['t-work'] }] },
    { name: 'tag (multi id)', filters: [{ type: 'tag', tagIds: ['t-work', 't-home'] }] },
    { name: 'tag (empty)', filters: [{ type: 'tag', tagIds: [] }] },
    {
      name: 'mixed bag',
      filters: [
        { type: 'tag', tagIds: ['a', 'b'] },
        { type: 'status', values: ['DONE'] },
        { type: 'priority', values: ['3'] },
        { type: 'hasDueDate', value: true },
        { type: 'hasBacklinks', value: false },
        { type: 'excludeTemplates', value: true },
      ],
    },
  ]

  for (const { name, filters } of cases) {
    it(`round-trips ${name}`, () => {
      const canonical = graphFiltersToCanonical(filters)
      const back = canonicalToGraphFilters(canonical)
      expect(back).toEqual(filters)
    })
  }

  it('drops canonical predicates that are not graph dimensions on collapse', () => {
    const predicates: FilterPredicate[] = [
      { kind: 'status', values: ['TODO'], isNull: false, exclude: false },
      // pages-only — not a graph dimension
      { kind: 'orphan' },
      { kind: 'pathGlob', pattern: '*', exclude: false },
    ]
    expect(canonicalToGraphFilters(predicates)).toEqual([{ type: 'status', values: ['TODO'] }])
  })
})

// ---------------------------------------------------------------------------
// Canonical shape — DIRECT calls (not round-tripped).
//
// The round-trip tests above only assert on the final `GraphFilter[]` after
// going graph → canonical → graph, which doesn't distinguish several internal
// encoding/branch details from equally-shaped alternatives (e.g. `undefined`
// vs `null`, or a padded intermediate array whose extra entry gets filtered
// back out on the return trip). These tests call the exported converters
// directly and assert on their immediate output.
// ---------------------------------------------------------------------------

describe('canonical shape — direct (not round-tripped)', () => {
  it('hasDueDate true encodes the After/sentinel marker', () => {
    expect(graphFilterToCanonical({ type: 'hasDueDate', value: true })).toEqual({
      kind: 'date',
      field: 'due',
      predicate: { type: 'After', date: '__graph-has-date__' },
    })
  })

  it('hasDueDate false encodes IsNull', () => {
    expect(graphFilterToCanonical({ type: 'hasDueDate', value: false })).toEqual({
      kind: 'date',
      field: 'due',
      predicate: { type: 'IsNull' },
    })
  })

  it('graphFilterToCanonical handles a tag filter directly (bypassed by the plural helper)', () => {
    expect(graphFilterToCanonical({ type: 'tag', tagIds: ['t-work'] })).toEqual({
      kind: 'tag',
      by: 'id',
      tagId: 't-work',
    })
    // Empty-tagIds case (the `?? ''` fallback), also only reachable when this
    // singular helper is called directly.
    expect(graphFilterToCanonical({ type: 'tag', tagIds: [] })).toEqual({
      kind: 'tag',
      by: 'id',
      tagId: '',
    })
  })

  it('canonicalToGraphFilter maps tag/by:id back to a graph tag filter directly', () => {
    expect(canonicalToGraphFilter({ kind: 'tag', by: 'id', tagId: 't-work' })).toEqual({
      type: 'tag',
      tagIds: ['t-work'],
    })
  })

  it('canonicalToGraphFilter drops tag/by:name (not graph-expressible)', () => {
    expect(canonicalToGraphFilter({ kind: 'tag', by: 'name', name: 'work' })).toBeNull()
  })

  it('canonicalToGraphFilter drops status with isNull set', () => {
    expect(
      canonicalToGraphFilter({ kind: 'status', values: ['TODO'], isNull: true, exclude: false }),
    ).toBeNull()
  })

  it('canonicalToGraphFilter drops status with exclude set', () => {
    expect(
      canonicalToGraphFilter({ kind: 'status', values: ['TODO'], isNull: false, exclude: true }),
    ).toBeNull()
  })

  it('canonicalToGraphFilter drops a date predicate on a non-graph field', () => {
    expect(
      canonicalToGraphFilter({ kind: 'date', field: 'created', predicate: { type: 'IsNull' } }),
    ).toBeNull()
    expect(
      canonicalToGraphFilter({
        kind: 'date',
        field: 'lastEdited',
        predicate: { type: 'IsNull' },
      }),
    ).toBeNull()
  })

  it('canonicalToGraphFilter returns null (not undefined) for a kind with no graph mapping', () => {
    expect(canonicalToGraphFilter({ kind: 'orphan' })).toBe(null)
  })

  it('graphFiltersToCanonical does not pad the result for an empty filter list', () => {
    expect(graphFiltersToCanonical([])).toEqual([])
  })

  it('graphFiltersToCanonical does not add a spurious empty-id tag entry when ids are present', () => {
    expect(graphFiltersToCanonical([{ type: 'tag', tagIds: ['t-work'] }])).toEqual([
      { kind: 'tag', by: 'id', tagId: 't-work' },
    ])
  })

  it('canonicalToGraphFilters drops a tag predicate referenced by name (not graph-expressible)', () => {
    expect(canonicalToGraphFilters([{ kind: 'tag', by: 'name', name: 'work' }])).toEqual([])
  })

  // `canonicalToGraphFilters` is reachable with data that never went through
  // type-checked construction: `GraphFilterBar.readPersistedFilters` parses
  // `localStorage` JSON and only verifies each entry has a string `kind`
  // before casting the array to `FilterPredicate[]` (see readPersistedFilters
  // in GraphFilterBar.tsx). Legacy/corrupted storage can therefore hand this
  // function a non-'tag' predicate that incidentally carries a `by: 'id'`
  // property. The line-277 guard (`p.kind === 'tag' && p.by === 'id'`) must
  // check BOTH operands to reject it — verified here via an unchecked cast
  // that mirrors that real call site rather than a type-checked literal.
  it('a non-tag predicate carrying a stray by:"id" field (unchecked cast, mirrors persisted-storage input) is not swept into the tag collection', () => {
    const malformed = {
      kind: 'status',
      by: 'id',
      values: ['TODO'],
      isNull: false,
      exclude: false,
    } as unknown as FilterPredicate
    expect(canonicalToGraphFilters([malformed])).toEqual([{ type: 'status', values: ['TODO'] }])
  })
})
