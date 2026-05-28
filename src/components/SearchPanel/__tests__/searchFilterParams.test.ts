/**
 * Tests for `astFilterParams` (PEND-58g FE-A18).
 *
 * The function maps a parsed `AstFilterProjection` (+ resolved tag ids)
 * to the `searchBlocks` IPC filter bundle. The contract under test:
 *  - empty arrays collapse to `undefined` (so the field is omitted from
 *    the IPC payload rather than sent as `[]`),
 *  - non-empty arrays pass through verbatim,
 *  - `dueFilter` / `scheduledFilter` pass through (incl. `null`),
 *  - `tagIds` come from the resolver argument, not the projection.
 */
import { describe, expect, it } from 'vitest'

import type { AstFilterProjection } from '@/lib/search-query'

import { astFilterParams } from '../searchFilterParams'

function emptyProjection(): AstFilterProjection {
  return {
    tagNames: [],
    includePageGlobs: [],
    excludePageGlobs: [],
    stateFilter: [],
    priorityFilter: [],
    excludedStateFilter: [],
    excludedPriorityFilter: [],
    dueFilter: null,
    scheduledFilter: null,
    propertyFilters: [],
    excludedPropertyFilters: [],
  }
}

describe('astFilterParams', () => {
  it('collapses empty arrays to undefined and passes null date filters through', () => {
    const params = astFilterParams(emptyProjection(), [])
    expect(params).toEqual({
      tagIds: undefined,
      includePageGlobs: undefined,
      excludePageGlobs: undefined,
      stateFilter: undefined,
      priorityFilter: undefined,
      excludedStateFilter: undefined,
      excludedPriorityFilter: undefined,
      dueFilter: null,
      scheduledFilter: null,
      propertyFilters: undefined,
      excludedPropertyFilters: undefined,
    })
  })

  it('passes non-empty arrays through and takes tagIds from the resolver arg', () => {
    const projection: AstFilterProjection = {
      ...emptyProjection(),
      // `tagNames` on the projection is irrelevant — ids come from the arg.
      tagNames: ['urgent'],
      includePageGlobs: ['Projects/*'],
      excludePageGlobs: ['Archive/*'],
      stateFilter: ['TODO', 'DOING'],
      priorityFilter: ['A'],
      excludedStateFilter: ['DONE'],
      excludedPriorityFilter: ['C'],
      propertyFilters: [{ key: 'owner', value: 'me' }],
      excludedPropertyFilters: [{ key: 'archived', value: 'true' }],
    }
    const params = astFilterParams(projection, ['TAG_01'])
    expect(params.tagIds).toEqual(['TAG_01'])
    expect(params.includePageGlobs).toEqual(['Projects/*'])
    expect(params.excludePageGlobs).toEqual(['Archive/*'])
    expect(params.stateFilter).toEqual(['TODO', 'DOING'])
    expect(params.priorityFilter).toEqual(['A'])
    expect(params.excludedStateFilter).toEqual(['DONE'])
    expect(params.excludedPriorityFilter).toEqual(['C'])
    expect(params.propertyFilters).toEqual([{ key: 'owner', value: 'me' }])
    expect(params.excludedPropertyFilters).toEqual([{ key: 'archived', value: 'true' }])
  })

  it('forwards named and comparison-op date filters', () => {
    const projection: AstFilterProjection = {
      ...emptyProjection(),
      dueFilter: { kind: 'named', name: 'today' },
      scheduledFilter: { kind: 'op', op: '>=', date: '2026-01-01' },
    }
    const params = astFilterParams(projection, [])
    expect(params.dueFilter).toEqual({ kind: 'named', name: 'today' })
    expect(params.scheduledFilter).toEqual({ kind: 'op', op: '>=', date: '2026-01-01' })
  })
})
