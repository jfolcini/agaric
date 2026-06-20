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

import {
  astFilterParams,
  type SearchFilterParams,
  UNRESOLVED_TAG_SENTINEL,
} from '../searchFilterParams'

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

// ---------------------------------------------------------------------------
// Issue #1646 step 1 — canonical-model adapter PARITY.
//
// `astFilterParams` now routes the AST projection through the canonical
// `FilterPredicate` model (`searchProjectionToCanonical` → `canonicalToSearch
// Projection`) before emitting the IPC bundle. This test pins the byte shape:
// the emitted `SearchFilterParams` MUST be identical to the pre-migration
// direct projection→params mapping reproduced below, for a representative set
// of queries (incl. `state:none`, negations, tag, prop, date).
// ---------------------------------------------------------------------------

/**
 * The pre-migration emit logic, copied verbatim from `astFilterParams` BEFORE
 * the canonical-model adapter was inserted (the projection→params mapping with
 * the empty→undefined collapse and the #717 tag sentinel). This is the parity
 * oracle: if the adapter changes any emitted byte, these assertions break.
 */
function legacyAstFilterParams(
  projection: AstFilterProjection,
  tagIds: string[],
): SearchFilterParams {
  const hasUnresolvedTag = projection.tagNames.length > tagIds.length
  return {
    tagIds: hasUnresolvedTag ? [UNRESOLVED_TAG_SENTINEL] : tagIds.length === 0 ? undefined : tagIds,
    includePageGlobs:
      projection.includePageGlobs.length === 0 ? undefined : projection.includePageGlobs,
    excludePageGlobs:
      projection.excludePageGlobs.length === 0 ? undefined : projection.excludePageGlobs,
    stateFilter: projection.stateFilter.length === 0 ? undefined : projection.stateFilter,
    priorityFilter: projection.priorityFilter.length === 0 ? undefined : projection.priorityFilter,
    excludedStateFilter:
      projection.excludedStateFilter.length === 0 ? undefined : projection.excludedStateFilter,
    excludedPriorityFilter:
      projection.excludedPriorityFilter.length === 0
        ? undefined
        : projection.excludedPriorityFilter,
    dueFilter: projection.dueFilter,
    scheduledFilter: projection.scheduledFilter,
    propertyFilters:
      projection.propertyFilters.length === 0 ? undefined : projection.propertyFilters,
    excludedPropertyFilters:
      projection.excludedPropertyFilters.length === 0
        ? undefined
        : projection.excludedPropertyFilters,
  }
}

describe('astFilterParams canonical-adapter parity (#1646)', () => {
  const cases: { name: string; projection: AstFilterProjection; tagIds: string[] }[] = [
    { name: 'empty', projection: emptyProjection(), tagIds: [] },
    {
      name: 'tag (resolved)',
      projection: { ...emptyProjection(), tagNames: ['work'] },
      tagIds: ['TAG_WORK'],
    },
    {
      name: 'tag (unresolved → sentinel)',
      projection: { ...emptyProjection(), tagNames: ['typo'] },
      tagIds: [],
    },
    {
      name: 'path include + exclude',
      projection: {
        ...emptyProjection(),
        includePageGlobs: ['Projects/*'],
        excludePageGlobs: ['Archive/*'],
      },
      tagIds: [],
    },
    {
      name: 'state + not-state',
      projection: {
        ...emptyProjection(),
        stateFilter: ['TODO', 'DOING'],
        excludedStateFilter: ['DONE'],
      },
      tagIds: [],
    },
    {
      // #1647 — `state:none` / `not-state:none` keep the literal `'none'` value
      // string; the backend `todo_state IS NULL` sentinel path is preserved.
      name: 'state:none + not-state:none',
      projection: {
        ...emptyProjection(),
        stateFilter: ['none'],
        excludedStateFilter: ['none'],
      },
      tagIds: [],
    },
    {
      name: 'priority + not-priority',
      projection: {
        ...emptyProjection(),
        priorityFilter: ['A'],
        excludedPriorityFilter: ['C'],
      },
      tagIds: [],
    },
    {
      name: 'due named + scheduled op',
      projection: {
        ...emptyProjection(),
        dueFilter: { kind: 'named', name: 'today' },
        scheduledFilter: { kind: 'op', op: '>=', date: '2026-01-01' },
      },
      tagIds: [],
    },
    {
      name: 'due:none named sentinel',
      projection: { ...emptyProjection(), dueFilter: { kind: 'named', name: 'none' } },
      tagIds: [],
    },
    {
      name: 'every date op',
      projection: {
        ...emptyProjection(),
        dueFilter: { kind: 'op', op: '<', date: '2026-03-01' },
        scheduledFilter: { kind: 'op', op: '=', date: '2026-04-01' },
      },
      tagIds: [],
    },
    {
      name: 'prop + not-prop',
      projection: {
        ...emptyProjection(),
        propertyFilters: [{ key: 'owner', value: 'me' }],
        excludedPropertyFilters: [{ key: 'archived', value: 'true' }],
      },
      tagIds: [],
    },
    {
      name: 'mixed bag (all categories)',
      projection: {
        tagNames: ['work'],
        includePageGlobs: ['Projects/*'],
        excludePageGlobs: ['Archive/*'],
        stateFilter: ['TODO', 'none'],
        priorityFilter: ['A'],
        excludedStateFilter: ['DONE'],
        excludedPriorityFilter: ['C'],
        dueFilter: { kind: 'named', name: 'overdue' },
        scheduledFilter: { kind: 'op', op: '<=', date: '2026-05-01' },
        propertyFilters: [{ key: 'owner', value: 'me' }],
        excludedPropertyFilters: [{ key: 'archived', value: 'true' }],
      },
      tagIds: ['TAG_WORK'],
    },
  ]

  for (const { name, projection, tagIds } of cases) {
    it(`emits byte-identical SearchFilterParams vs pre-migration: ${name}`, () => {
      const viaCanonical = astFilterParams(projection, tagIds)
      const legacy = legacyAstFilterParams(projection, tagIds)
      expect(viaCanonical).toEqual(legacy)
    })
  }
})
