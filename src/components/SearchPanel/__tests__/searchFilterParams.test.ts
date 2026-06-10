/**
 * Tests for `astFilterParams` (PEND-58g FE-A18).
 *
 * The function maps a parsed `AstFilterProjection` (+ resolved tag ids)
 * to the `searchBlocks` IPC filter bundle. The contract under test:
 *  - empty arrays collapse to `undefined` (so the field is omitted from
 *    the IPC payload rather than sent as `[]`),
 *  - non-empty arrays pass through verbatim,
 *  - `dueFilter` / `scheduledFilter` pass through (incl. `null`),
 *  - `tagIds` come from the resolver argument, not the projection,
 *  - #717 — when the projection names tags but resolution settled with
 *    fewer ids than names, the bundle carries the matches-nothing
 *    sentinel instead of dropping the tag constraint (which would
 *    return EVERY FTS match while the tag chip renders as active).
 */
import { describe, expect, it } from 'vitest'

import type { AstFilterProjection } from '@/lib/search-query'

import { astFilterParams, UNRESOLVED_TAG_SENTINEL } from '../searchFilterParams'

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

  // Issue #717 — a `tag:` filter whose name resolved to no existing tag
  // must NOT be silently dropped. `meeting tag:#typo` previously sent
  // `tagIds: undefined` (= no tag filter) and returned all FTS matches
  // for "meeting" while the tag chip rendered as an active filter.
  it('projects the matches-nothing sentinel when a named tag did not resolve (#717)', () => {
    const projection: AstFilterProjection = {
      ...emptyProjection(),
      tagNames: ['typo'],
    }
    const params = astFilterParams(projection, [])
    expect(params.tagIds).toEqual([UNRESOLVED_TAG_SENTINEL])
  })

  it('projects the sentinel when only SOME named tags resolved (#717)', () => {
    const projection: AstFilterProjection = {
      ...emptyProjection(),
      tagNames: ['wip', 'typo'],
    }
    // ALL semantics backend-side: one unresolvable tag means the whole
    // conjunction can never match — the sentinel alone expresses that.
    const params = astFilterParams(projection, ['TAG_WIP'])
    expect(params.tagIds).toEqual([UNRESOLVED_TAG_SENTINEL])
  })

  it('passes resolved ids through verbatim when every named tag resolved', () => {
    const projection: AstFilterProjection = {
      ...emptyProjection(),
      tagNames: ['wip', 'urgent'],
    }
    const params = astFilterParams(projection, ['TAG_WIP', 'TAG_URGENT'])
    expect(params.tagIds).toEqual(['TAG_WIP', 'TAG_URGENT'])
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
