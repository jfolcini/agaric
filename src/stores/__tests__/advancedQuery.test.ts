import { beforeEach, describe, expect, it } from 'vitest'

import type { AggregateSpec, GroupSpec, SortKey } from '@/lib/tauri'

import {
  selectAdvancedQueryControlsForSpace,
  selectAdvancedQueryFiltersForSpace,
  useAdvancedQueryStore,
} from '../advancedQuery'

const SPACE = 'SPACE_A'

beforeEach(() => {
  useAdvancedQueryStore.setState({ filtersBySpace: {}, controlsBySpace: {}, nextAddId: 0 })
})

describe('advancedQuery store — controls', () => {
  it('returns a stable frozen empty controls slice for an absent space', () => {
    const a = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE)
    const b = selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), 'SPACE_B')
    // Same frozen default reference for any absent slice (referential idempotency).
    expect(a).toBe(b)
    expect(a).toEqual({ fulltext: '', sort: [], groupBy: null, aggregates: [] })
  })

  it('sets the full-text term per space and is a no-op when unchanged', () => {
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hello')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('hello')

    const before = useAdvancedQueryStore.getState().controlsBySpace
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hello')
    // Identical value ⇒ same state object (no churn).
    expect(useAdvancedQueryStore.getState().controlsBySpace).toBe(before)
  })

  it('replaces the ordered sort keys', () => {
    const sort: SortKey[] = [
      { source: { type: 'Column', name: 'priority' }, desc: true },
      { source: { type: 'Relevance' } },
    ]
    useAdvancedQueryStore.getState().setSort(SPACE, sort)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).sort,
    ).toEqual(sort)
  })

  it('sets and clears the grouping directive', () => {
    const groupBy: GroupSpec = { key: { type: 'Tag' } }
    useAdvancedQueryStore.getState().setGroupBy(SPACE, groupBy)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).groupBy,
    ).toEqual(groupBy)

    useAdvancedQueryStore.getState().setGroupBy(SPACE, null)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).groupBy,
    ).toBeNull()
  })

  it('replaces the aggregate specs', () => {
    const aggregates: AggregateSpec[] = [
      { op: 'count', target: null },
      { op: 'sum', target: { type: 'Column', name: 'position' } },
    ]
    useAdvancedQueryStore.getState().setAggregates(SPACE, aggregates)
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).aggregates,
    ).toEqual(aggregates)
  })

  it('partitions controls per space (no cross-space bleed)', () => {
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'space-a-term')
    useAdvancedQueryStore.getState().setFulltext('SPACE_B', 'space-b-term')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('space-a-term')
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), 'SPACE_B').fulltext,
    ).toBe('space-b-term')
  })

  it('leaves the chip API working alongside the new controls', () => {
    useAdvancedQueryStore.getState().addFilter(SPACE, { type: 'Tag', tag: 'project' })
    useAdvancedQueryStore.getState().setFulltext(SPACE, 'hi')
    const filters = selectAdvancedQueryFiltersForSpace(useAdvancedQueryStore.getState(), SPACE)
    expect(filters).toHaveLength(1)
    expect(filters[0]).toMatchObject({ type: 'Tag', tag: 'project' })
    expect(
      selectAdvancedQueryControlsForSpace(useAdvancedQueryStore.getState(), SPACE).fulltext,
    ).toBe('hi')
  })
})
