/**
 * Canonical filter model — Issue #1646.
 *
 * These tests are the load-bearing guarantee of the foundational slice: every
 * existing filter shape from all FOUR vocabularies must be LOSSLESSLY
 * representable in the canonical `FilterPredicate` model, and the migrated
 * graph surface must round-trip exactly (graph → canonical → graph).
 */

import { describe, expect, it } from 'vitest'

import type { BacklinkFilter, FilterPrimitive } from '@/lib/bindings'
import type { GraphFilter } from '@/lib/graph-filters'
import type { AstFilterProjection } from '@/lib/search-query'

import {
  backlinkFilterToCanonical,
  canonicalToBacklinkFilter,
  canonicalToGraphFilters,
  canonicalToSearchProjection,
  FILTER_SURFACE_ALLOWLIST,
  type FilterPredicate,
  filterPrimitiveToCanonical,
  graphFiltersToCanonical,
  searchProjectionToCanonical,
  surfaceSupports,
} from '../model'

// ---------------------------------------------------------------------------
// Graph surface — lossless ROUND TRIP (the migrated proof surface).
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

  it('produces canonical predicates that all pass the graph allow-list', () => {
    const canonical = graphFiltersToCanonical([
      { type: 'tag', tagIds: ['a'] },
      { type: 'status', values: ['TODO'] },
      { type: 'priority', values: ['1'] },
      { type: 'hasDueDate', value: true },
      { type: 'hasScheduledDate', value: false },
      { type: 'hasBacklinks', value: true },
      { type: 'excludeTemplates', value: true },
    ])
    for (const p of canonical) {
      expect(surfaceSupports('graph', p.kind)).toBe(true)
    }
  })

  it('drops canonical predicates outside the graph allow-list on collapse', () => {
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
// Backlink vocabulary — lossless ONE-WAY into the canonical model.
// ---------------------------------------------------------------------------

describe('backlink vocabulary → canonical (lossless, every leaf)', () => {
  const cases: { name: string; filter: BacklinkFilter; expected: FilterPredicate }[] = [
    {
      name: 'PropertyText Eq',
      filter: { type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE' },
      expected: {
        kind: 'property',
        key: 'todo',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'DONE' } },
        exclude: false,
      },
    },
    {
      name: 'PropertyNum',
      filter: { type: 'PropertyNum', key: 'count', op: 'Eq', value: 42 },
      expected: {
        kind: 'property',
        key: 'count',
        predicate: { type: 'Eq', value: { type: 'Num', value: 42 } },
        exclude: false,
      },
    },
    {
      name: 'PropertyIsSet',
      filter: { type: 'PropertyIsSet', key: 'k' },
      expected: { kind: 'property', key: 'k', predicate: { type: 'Exists' }, exclude: false },
    },
    {
      name: 'PropertyIsEmpty',
      filter: { type: 'PropertyIsEmpty', key: 'k' },
      expected: { kind: 'property', key: 'k', predicate: { type: 'NotExists' }, exclude: false },
    },
    {
      name: 'TodoState',
      filter: { type: 'TodoState', state: 'TODO' },
      expected: { kind: 'status', values: ['TODO'], isNull: false, exclude: false },
    },
    {
      name: 'Priority',
      filter: { type: 'Priority', level: '1' },
      expected: { kind: 'priority', values: ['1'], exclude: false },
    },
    {
      name: 'DueDate Lte',
      filter: { type: 'DueDate', op: 'Lte', value: '2026-01-01' },
      expected: {
        kind: 'date',
        field: 'due',
        predicate: { type: 'OnOrBefore', date: '2026-01-01' },
      },
    },
    {
      name: 'HasTag',
      filter: { type: 'HasTag', tag_id: 't1' },
      expected: { kind: 'tag', by: 'id', tagId: 't1' },
    },
    {
      name: 'HasTagPrefix',
      filter: { type: 'HasTagPrefix', prefix: 'proj/' },
      expected: { kind: 'tagPrefix', prefix: 'proj/' },
    },
    {
      name: 'Contains',
      filter: { type: 'Contains', query: 'hello' },
      expected: { kind: 'contains', query: 'hello' },
    },
    {
      name: 'CreatedInRange',
      filter: { type: 'CreatedInRange', after: '2026-01-01', before: null },
      expected: { kind: 'createdRange', after: '2026-01-01', before: null },
    },
    {
      name: 'BlockType',
      filter: { type: 'BlockType', block_type: 'task' },
      expected: { kind: 'blockType', values: ['task'], exclude: false },
    },
    {
      name: 'SourcePage',
      filter: { type: 'SourcePage', included: ['a'], excluded: ['b'] },
      expected: { kind: 'sourcePage', included: ['a'], excluded: ['b'] },
    },
  ]

  for (const { name, filter, expected } of cases) {
    it(`maps ${name}`, () => {
      expect(backlinkFilterToCanonical(filter)).toEqual(expected)
    })
  }

  it('returns null for compound wrappers (managed at list level)', () => {
    expect(backlinkFilterToCanonical({ type: 'And', filters: [] })).toBeNull()
    expect(backlinkFilterToCanonical({ type: 'Or', filters: [] })).toBeNull()
    expect(
      backlinkFilterToCanonical({ type: 'Not', filter: { type: 'HasTag', tag_id: 'x' } }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Backlink vocabulary — lossless ROUND TRIP (canonical ⇄ BacklinkFilter).
//
// Issue #1646 surface 4: the backlink surface now PROJECTS its emitted wire
// shape FROM the canonical model. The round-trip must be byte-exact for every
// category the builder emits — including the #1647 status-`none` ⇒
// `PropertyIsEmpty{key:'todo'}` sentinel and every property comparison op.
// ---------------------------------------------------------------------------

describe('backlink round-trip (BacklinkFilter ⇄ canonical, byte-exact)', () => {
  // Every BacklinkFilter leaf the surface can produce. Property leaves cover
  // every CompareOp + value-variant so no op is silently collapsed.
  const roundTrip: BacklinkFilter[] = [
    // Status: literal value (PropertyText{key:'todo'}) ...
    { type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE' },
    // ... and the #1647 `none` sentinel (PropertyIsEmpty, NOT a literal match).
    { type: 'PropertyIsEmpty', key: 'todo' },
    // Priority (PropertyText{key:'priority'}).
    { type: 'PropertyText', key: 'priority', op: 'Eq', value: '1' },
    // Property — text, every op.
    { type: 'PropertyText', key: 'k', op: 'Eq', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Neq', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Lt', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Gt', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Lte', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Gte', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'Contains', value: 'v' },
    { type: 'PropertyText', key: 'k', op: 'StartsWith', value: 'v' },
    // Property — numeric & date, op preserved.
    { type: 'PropertyNum', key: 'count', op: 'Eq', value: 42 },
    { type: 'PropertyNum', key: 'count', op: 'Gt', value: 3.5 },
    { type: 'PropertyDate', key: 'due', op: 'Lte', value: '2026-01-01' },
    // Property set / empty.
    { type: 'PropertyIsSet', key: 'k' },
    { type: 'PropertyIsEmpty', key: 'k' },
    // Tag / tag-prefix.
    { type: 'HasTag', tag_id: 't1' },
    { type: 'HasTagPrefix', prefix: 'proj/' },
    // Contains.
    { type: 'Contains', query: 'hello world' },
    // Created date range (include both bounds + open bound).
    { type: 'CreatedInRange', after: '2026-01-01', before: '2026-02-01' },
    { type: 'CreatedInRange', after: '2026-01-01', before: null },
    { type: 'CreatedInRange', after: null, before: '2026-02-01' },
    // Block type.
    { type: 'BlockType', block_type: 'task' },
    // Source page include/exclude.
    { type: 'SourcePage', included: ['a'], excluded: ['b'] },
    // Non-builder leaves that still must survive the round-trip.
    { type: 'TodoState', state: 'TODO' },
    { type: 'Priority', level: '2' },
    { type: 'DueDate', op: 'Gte', value: '2026-03-01' },
  ]

  for (const filter of roundTrip) {
    it(`round-trips ${filter.type} (${JSON.stringify(filter)})`, () => {
      const canonical = backlinkFilterToCanonical(filter)
      expect(canonical).not.toBeNull()
      expect(canonicalToBacklinkFilter(canonical as FilterPredicate)).toEqual(filter)
    })
  }

  it('preserves the #1647 status-none ⇒ PropertyIsEmpty{key:todo} sentinel exactly', () => {
    const noneEmit: BacklinkFilter = { type: 'PropertyIsEmpty', key: 'todo' }
    const canonical = backlinkFilterToCanonical(noneEmit)
    expect(canonical).toEqual({
      kind: 'property',
      key: 'todo',
      predicate: { type: 'NotExists' },
      exclude: false,
    })
    // It must NOT become a literal `value='none'` text match.
    const back = canonicalToBacklinkFilter(canonical as FilterPredicate)
    expect(back).toEqual({ type: 'PropertyIsEmpty', key: 'todo' })
    expect(back).not.toEqual({ type: 'PropertyText', key: 'todo', op: 'Eq', value: 'none' })
  })

  it('drops compound/out-of-allowlist predicates from the inverse', () => {
    // Compound leaves are managed at the list level, not by the inverse.
    expect(canonicalToBacklinkFilter({ kind: 'orphan' })).toBeNull()
    expect(canonicalToBacklinkFilter({ kind: 'pathGlob', pattern: '*', exclude: false })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FilterPrimitive (pages / advanced / search-compound) → canonical.
// ---------------------------------------------------------------------------

describe('FilterPrimitive vocabulary → canonical (lossless leaves)', () => {
  const cases: { name: string; filter: FilterPrimitive; expected: FilterPredicate }[] = [
    {
      name: 'Tag',
      filter: { type: 'Tag', tag: 'work' },
      expected: { kind: 'tag', by: 'name', name: 'work' },
    },
    {
      name: 'PathGlob',
      filter: { type: 'PathGlob', pattern: 'proj/*', exclude: true },
      expected: { kind: 'pathGlob', pattern: 'proj/*', exclude: true },
    },
    {
      name: 'HasProperty',
      filter: { type: 'HasProperty', key: 'status', predicate: { type: 'Exists' } },
      expected: { kind: 'property', key: 'status', predicate: { type: 'Exists' }, exclude: false },
    },
    {
      name: 'LastEdited',
      filter: { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } },
      expected: { kind: 'lastEdited', spec: { type: 'Rolling', days: 7 } },
    },
    {
      name: 'Space',
      filter: { type: 'Space', space_id: 's1' },
      expected: { kind: 'space', spaceId: 's1' },
    },
    {
      name: 'Priority',
      filter: { type: 'Priority', priority: '2' },
      expected: { kind: 'priority', values: ['2'], exclude: false },
    },
    {
      name: 'State (multi + flags)',
      filter: { type: 'State', values: ['TODO', 'DOING'], is_null: true, exclude: true },
      expected: { kind: 'status', values: ['TODO', 'DOING'], isNull: true, exclude: true },
    },
    {
      name: 'BlockType (multi)',
      filter: { type: 'BlockType', values: ['task', 'note'], exclude: false },
      expected: { kind: 'blockType', values: ['task', 'note'], exclude: false },
    },
    {
      name: 'DueDate',
      filter: { type: 'DueDate', predicate: { type: 'IsNull' } },
      expected: { kind: 'date', field: 'due', predicate: { type: 'IsNull' } },
    },
    {
      name: 'Scheduled',
      filter: {
        type: 'Scheduled',
        predicate: { type: 'Between', from: '2026-01-01', to: '2026-02-01' },
      },
      expected: {
        kind: 'date',
        field: 'scheduled',
        predicate: { type: 'Between', from: '2026-01-01', to: '2026-02-01' },
      },
    },
    {
      name: 'Created',
      filter: { type: 'Created', after: null, before: '2026-06-01' },
      expected: { kind: 'createdRange', after: null, before: '2026-06-01' },
    },
    {
      name: 'LinksTo',
      filter: { type: 'LinksTo', target: 'b1' },
      expected: { kind: 'linksTo', target: 'b1' },
    },
    {
      name: 'LinkedFrom',
      filter: { type: 'LinkedFrom', source: 'b2' },
      expected: { kind: 'linkedFrom', source: 'b2' },
    },
    { name: 'Orphan', filter: { type: 'Orphan' }, expected: { kind: 'orphan' } },
    { name: 'Stub', filter: { type: 'Stub' }, expected: { kind: 'stub' } },
    {
      name: 'HasNoInboundLinks',
      filter: { type: 'HasNoInboundLinks' },
      expected: { kind: 'hasNoInboundLinks' },
    },
    {
      name: 'Regex',
      filter: { type: 'Regex', pattern: '\\bfoo\\b' },
      expected: { kind: 'regex', pattern: '\\bfoo\\b' },
    },
    {
      name: 'CaseSensitive',
      filter: { type: 'CaseSensitive', enabled: true },
      expected: { kind: 'caseSensitive', enabled: true },
    },
    {
      name: 'WholeWord',
      filter: { type: 'WholeWord', enabled: false },
      expected: { kind: 'wholeWord', enabled: false },
    },
  ]

  for (const { name, filter, expected } of cases) {
    it(`maps ${name}`, () => {
      expect(filterPrimitiveToCanonical(filter)).toEqual(expected)
    })
  }

  it('returns null for the recursive / windowed leaves not yet flattened', () => {
    expect(
      filterPrimitiveToCanonical({
        type: 'HasParentMatching',
        matcher: { type: 'And', children: [] },
      }),
    ).toBeNull()
    expect(
      filterPrimitiveToCanonical({
        type: 'Snippet',
        spec: { maxTokens: 16, leftMarker: '[', rightMarker: ']' },
      }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Search surface — lossless ROUND TRIP (projection ⇄ canonical), Issue #1646
// step 1. Every category the search query-string AST can produce must
// round-trip search → canonical → search exactly, so `astFilterParams` emits a
// byte-identical IPC bundle through the adapter.
// ---------------------------------------------------------------------------

function emptySearchProjection(): AstFilterProjection {
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

describe('search surface round-trip (projection ⇄ canonical)', () => {
  const cases: { name: string; projection: AstFilterProjection }[] = [
    { name: 'empty', projection: emptySearchProjection() },
    {
      name: 'tag (by name)',
      projection: { ...emptySearchProjection(), tagNames: ['work', 'urgent'] },
    },
    {
      name: 'path include + exclude globs',
      projection: {
        ...emptySearchProjection(),
        includePageGlobs: ['Projects/*', 'Notes/*'],
        excludePageGlobs: ['Archive/*'],
      },
    },
    {
      name: 'state + not-state',
      projection: {
        ...emptySearchProjection(),
        stateFilter: ['TODO', 'DOING'],
        excludedStateFilter: ['DONE'],
      },
    },
    {
      // #1647 — `state:none` must stay the literal value string `'none'` so the
      // backend `todo_state IS NULL` sentinel path is preserved; never collapse
      // it to the canonical `isNull` flag in the search adapter.
      name: 'state:none + not-state:none (null sentinel preserved)',
      projection: {
        ...emptySearchProjection(),
        stateFilter: ['none'],
        excludedStateFilter: ['none'],
      },
    },
    {
      name: 'priority + not-priority',
      projection: {
        ...emptySearchProjection(),
        priorityFilter: ['A', 'B'],
        excludedPriorityFilter: ['C'],
      },
    },
    {
      name: 'due named bucket + scheduled op',
      projection: {
        ...emptySearchProjection(),
        dueFilter: { kind: 'named', name: 'today' },
        scheduledFilter: { kind: 'op', op: '>=', date: '2026-01-01' },
      },
    },
    {
      name: 'due:none named sentinel',
      projection: {
        ...emptySearchProjection(),
        dueFilter: { kind: 'named', name: 'none' },
      },
    },
    {
      name: 'every date comparison op',
      projection: {
        ...emptySearchProjection(),
        dueFilter: { kind: 'op', op: '<', date: '2026-03-01' },
        scheduledFilter: { kind: 'op', op: '=', date: '2026-04-01' },
      },
    },
    {
      name: 'prop + not-prop',
      projection: {
        ...emptySearchProjection(),
        propertyFilters: [{ key: 'owner', value: 'me' }],
        excludedPropertyFilters: [{ key: 'archived', value: 'true' }],
      },
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
    },
  ]

  for (const { name, projection } of cases) {
    it(`round-trips ${name}`, () => {
      const canonical = searchProjectionToCanonical(projection)
      const back = canonicalToSearchProjection(canonical)
      expect(back).toEqual(projection)
    })
  }

  it('produces canonical predicates that all pass the search allow-list', () => {
    const canonical = searchProjectionToCanonical({
      tagNames: ['work'],
      includePageGlobs: ['Projects/*'],
      excludePageGlobs: ['Archive/*'],
      stateFilter: ['TODO'],
      priorityFilter: ['A'],
      excludedStateFilter: ['DONE'],
      excludedPriorityFilter: ['C'],
      dueFilter: { kind: 'named', name: 'today' },
      scheduledFilter: { kind: 'op', op: '>=', date: '2026-01-01' },
      propertyFilters: [{ key: 'owner', value: 'me' }],
      excludedPropertyFilters: [{ key: 'archived', value: 'true' }],
    })
    for (const p of canonical) {
      expect(surfaceSupports('search', p.kind)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Allow-lists.
// ---------------------------------------------------------------------------

describe('per-surface allow-lists', () => {
  it('declares an allow-list for every surface', () => {
    expect(Object.keys(FILTER_SURFACE_ALLOWLIST).toSorted()).toEqual([
      'backlink',
      'graph',
      'pageBrowser',
      'search',
    ])
  })

  it('every allow-listed kind is a real FilterPredicate kind', () => {
    // A representative canonical value per kind, to prove the allow-list strings
    // are not typos and correspond to inhabitable variants.
    const allKinds = new Set<string>([
      'tag',
      'tagPrefix',
      'status',
      'priority',
      'property',
      'date',
      'createdRange',
      'lastEdited',
      'blockType',
      'pathGlob',
      'sourcePage',
      'space',
      'contains',
      'regex',
      'caseSensitive',
      'wholeWord',
      'linksTo',
      'linkedFrom',
      'hasBacklinks',
      'orphan',
      'stub',
      'hasNoInboundLinks',
      'excludeTemplates',
    ])
    for (const kinds of Object.values(FILTER_SURFACE_ALLOWLIST)) {
      for (const k of kinds) expect(allKinds.has(k)).toBe(true)
    }
  })

  it('surfaceSupports reflects membership', () => {
    expect(surfaceSupports('graph', 'excludeTemplates')).toBe(true)
    expect(surfaceSupports('graph', 'orphan')).toBe(false)
    expect(surfaceSupports('backlink', 'tagPrefix')).toBe(true)
    expect(surfaceSupports('pageBrowser', 'orphan')).toBe(true)
    expect(surfaceSupports('search', 'orphan')).toBe(false)
  })
})
