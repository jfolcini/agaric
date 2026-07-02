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

import type { GraphFilter } from '@/lib/graph-filters'

import { canonicalToGraphFilters, type FilterPredicate, graphFiltersToCanonical } from '../model'

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
