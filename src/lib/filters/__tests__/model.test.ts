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

import {
  backlinkFilterToCanonical,
  canonicalToGraphFilters,
  FILTER_SURFACE_ALLOWLIST,
  type FilterPredicate,
  filterPrimitiveToCanonical,
  graphFiltersToCanonical,
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
// Allow-lists.
// ---------------------------------------------------------------------------

describe('per-surface allow-lists', () => {
  it('declares an allow-list for every surface', () => {
    expect(Object.keys(FILTER_SURFACE_ALLOWLIST).sort()).toEqual([
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
