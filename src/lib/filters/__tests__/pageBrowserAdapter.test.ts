/**
 * PageBrowser ⇄ canonical adapter — Issue #1646, surface 2.
 *
 * These tests are the LOAD-BEARING parity guarantee for the PageBrowser
 * migration: the Add-Filter popover now projects every emitted filter through
 * the canonical `FilterPredicate` model, and these tests prove that projection
 * is lossless (the emitted `FilterPrimitive` is byte-identical to the
 * pre-migration direct-emit value) for every PageBrowser filter category,
 * including include/exclude variants and the empty-property / none sentinels.
 */

import { describe, expect, it } from 'vitest'

import type { FilterExpr, FilterPrimitive } from '@/lib/bindings'

import {
  canonicalToFilterPrimitive,
  type FilterPredicate,
  FILTER_SURFACE_ALLOWLIST,
  filterPrimitiveToCanonical,
  surfaceSupports,
} from '../model'
import { projectPageFilterThroughCanonical } from '../pageBrowserAdapter'

// ---------------------------------------------------------------------------
// Representative set covering EVERY PageBrowser filter category, with the
// include/exclude variants and the absent-property (Exists/NotExists) + none
// (State is_null) sentinels that #1647 warns must never regress.
// ---------------------------------------------------------------------------

const PAGE_BROWSER_FILTERS: { name: string; filter: FilterPrimitive }[] = [
  // --- shared group --------------------------------------------------------
  { name: 'Tag (by name)', filter: { type: 'Tag', tag: 'work' } },
  { name: 'PathGlob include', filter: { type: 'PathGlob', pattern: 'proj/*', exclude: false } },
  { name: 'PathGlob exclude', filter: { type: 'PathGlob', pattern: 'proj/*', exclude: true } },
  // Property predicate — the four kinds the popover emits, incl. the
  // absent-property (#1647) sentinels Exists / NotExists.
  {
    name: 'HasProperty Eq (literal-match)',
    filter: {
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Eq', value: { type: 'Text', value: 'done' } },
    },
  },
  {
    name: 'HasProperty Ne',
    filter: {
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Ne', value: { type: 'Text', value: 'done' } },
    },
  },
  {
    name: 'HasProperty Exists (property is set)',
    filter: { type: 'HasProperty', key: 'owner', predicate: { type: 'Exists' } },
  },
  {
    name: 'HasProperty NotExists (absent property — NOT literal match)',
    filter: { type: 'HasProperty', key: 'owner', predicate: { type: 'NotExists' } },
  },
  // Last-edited buckets (each bucket the popover offers).
  {
    name: 'LastEdited rolling/today',
    filter: { type: 'LastEdited', spec: { type: 'Rolling', days: 1 } },
  },
  {
    name: 'LastEdited rolling/week',
    filter: { type: 'LastEdited', spec: { type: 'Rolling', days: 7 } },
  },
  {
    name: 'LastEdited rolling/month',
    filter: { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } },
  },
  {
    name: 'LastEdited older',
    filter: { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } },
  },
  { name: 'Priority', filter: { type: 'Priority', priority: '1' } },
  // --- advanced group ------------------------------------------------------
  // State — multi-value, with the include / exclude / none(is_null) sentinels.
  {
    name: 'State include (multi)',
    filter: { type: 'State', values: ['TODO', 'DOING'], is_null: false, exclude: false },
  },
  {
    name: 'State exclude',
    filter: { type: 'State', values: ['DONE'], is_null: false, exclude: true },
  },
  {
    name: 'State none (is_null sentinel)',
    filter: { type: 'State', values: [], is_null: true, exclude: false },
  },
  {
    name: 'State values + none',
    filter: { type: 'State', values: ['TODO'], is_null: true, exclude: false },
  },
  {
    name: 'BlockType include',
    filter: { type: 'BlockType', values: ['content', 'page'], exclude: false },
  },
  {
    name: 'BlockType exclude',
    filter: { type: 'BlockType', values: ['todo'], exclude: true },
  },
  // Due / Scheduled — every DatePredicate op the editor offers, incl. IsNull.
  { name: 'DueDate IsNull', filter: { type: 'DueDate', predicate: { type: 'IsNull' } } },
  {
    name: 'DueDate Before',
    filter: { type: 'DueDate', predicate: { type: 'Before', date: '2026-01-01' } },
  },
  {
    name: 'DueDate After',
    filter: { type: 'DueDate', predicate: { type: 'After', date: '2026-01-01' } },
  },
  {
    name: 'DueDate OnOrBefore',
    filter: { type: 'DueDate', predicate: { type: 'OnOrBefore', date: '2026-01-01' } },
  },
  {
    name: 'DueDate OnOrAfter',
    filter: { type: 'DueDate', predicate: { type: 'OnOrAfter', date: '2026-01-01' } },
  },
  {
    name: 'DueDate On',
    filter: { type: 'DueDate', predicate: { type: 'On', date: '2026-01-01' } },
  },
  {
    name: 'DueDate Between',
    filter: {
      type: 'DueDate',
      predicate: { type: 'Between', from: '2026-01-01', to: '2026-02-01' },
    },
  },
  {
    name: 'Scheduled IsNull',
    filter: { type: 'Scheduled', predicate: { type: 'IsNull' } },
  },
  {
    name: 'Scheduled OnOrBefore',
    filter: { type: 'Scheduled', predicate: { type: 'OnOrBefore', date: '2026-03-01' } },
  },
  // Created — after-only / before-only / both bounds.
  { name: 'Created after-only', filter: { type: 'Created', after: '2026-01-01', before: null } },
  { name: 'Created before-only', filter: { type: 'Created', after: null, before: '2026-06-01' } },
  {
    name: 'Created both bounds',
    filter: { type: 'Created', after: '2026-01-01', before: '2026-06-01' },
  },
  // Relational link pickers.
  { name: 'LinksTo', filter: { type: 'LinksTo', target: 'b1' } },
  { name: 'LinkedFrom', filter: { type: 'LinkedFrom', source: 'b2' } },
  // --- pages-only boolean group --------------------------------------------
  { name: 'Orphan', filter: { type: 'Orphan' } },
  { name: 'Stub', filter: { type: 'Stub' } },
  { name: 'HasNoInboundLinks', filter: { type: 'HasNoInboundLinks' } },
]

describe('PageBrowser canonical round-trip (FilterPrimitive ⇄ canonical, lossless)', () => {
  for (const { name, filter } of PAGE_BROWSER_FILTERS) {
    it(`round-trips ${name} losslessly`, () => {
      const canonical = filterPrimitiveToCanonical(filter)
      // Every PageBrowser category must be representable in the canonical model.
      expect(canonical).not.toBeNull()
      const back = canonicalToFilterPrimitive(canonical as FilterPredicate)
      expect(back).toEqual(filter)
    })

    it(`projects ${name} through the canonical seam byte-identically`, () => {
      // This is the parity assertion: the value the popover would EMIT after the
      // migration (routed through the canonical seam) equals the value the
      // pre-migration popover emitted directly (the literal `filter`).
      expect(projectPageFilterThroughCanonical(filter)).toEqual(filter)
    })

    it(`maps ${name} into the pageBrowser allow-list`, () => {
      const canonical = filterPrimitiveToCanonical(filter) as FilterPredicate
      expect(surfaceSupports('pageBrowser', canonical.kind)).toBe(true)
    })
  }
})

describe('PageBrowser parity — emitted FilterPrimitive is unchanged vs pre-migration', () => {
  it('returns a value deep-equal to the direct-emit value for every category', () => {
    for (const { filter } of PAGE_BROWSER_FILTERS) {
      // Byte-identical: the projected emit equals the literal pre-migration emit.
      expect(projectPageFilterThroughCanonical(filter)).toStrictEqual(filter)
    }
  })

  it('preserves the State `is_null` (none) and `exclude` flag keys exactly', () => {
    // #1280 / #1647 — the popover always emits both flag keys; the canonical
    // round-trip must reproduce them (and never collapse `is_null` into an
    // absent-vs-literal mismatch).
    const stateNone: FilterPrimitive = {
      type: 'State',
      values: [],
      is_null: true,
      exclude: false,
    }
    const out = projectPageFilterThroughCanonical(stateNone)
    expect(out).toStrictEqual(stateNone)
    expect('is_null' in out && out.is_null).toBe(true)
  })

  it('preserves the absent-property (NotExists) vs literal-match (Eq) distinction', () => {
    // #1647 — `none`→`PropertyIsEmpty`/`NotExists` must never collapse into an
    // empty literal match. NotExists stays NotExists; Eq "" stays Eq "".
    const absent: FilterPrimitive = {
      type: 'HasProperty',
      key: 'owner',
      predicate: { type: 'NotExists' },
    }
    const emptyLiteral: FilterPrimitive = {
      type: 'HasProperty',
      key: 'owner',
      predicate: { type: 'Eq', value: { type: 'Text', value: '' } },
    }
    expect(projectPageFilterThroughCanonical(absent)).toStrictEqual(absent)
    expect(projectPageFilterThroughCanonical(emptyLiteral)).toStrictEqual(emptyLiteral)
    expect(projectPageFilterThroughCanonical(absent)).not.toStrictEqual(emptyLiteral)
  })
})

describe('PageBrowser deferred categories (compound / recursive) pass through untouched', () => {
  it('passes HasParentMatching through unchanged (no flat canonical category yet)', () => {
    const matcher: FilterExpr = {
      type: 'Leaf',
      primitive: { type: 'Tag', tag: 'x' },
    }
    const hasParent: FilterPrimitive = { type: 'HasParentMatching', matcher }
    // Deferred — filterPrimitiveToCanonical returns null for it; the adapter
    // must NOT drop or mutate it.
    expect(filterPrimitiveToCanonical(hasParent)).toBeNull()
    expect(projectPageFilterThroughCanonical(hasParent)).toBe(hasParent)
  })
})

describe('canonicalToFilterPrimitive — non-Pages canonical kinds return null', () => {
  // Predicates from OTHER surfaces' vocabulary have no Pages wire leaf; the
  // inverse must return null rather than fabricate one.
  const nonPages: FilterPredicate[] = [
    { kind: 'tag', by: 'id', tagId: 't1' },
    { kind: 'tagPrefix', prefix: 'proj/' },
    { kind: 'sourcePage', included: ['a'], excluded: [] },
    { kind: 'contains', query: 'hi' },
    { kind: 'hasBacklinks', value: true },
    { kind: 'excludeTemplates' },
    // exclude:true property has no Pages HasProperty wire form.
    {
      kind: 'property',
      key: 'k',
      predicate: { type: 'Exists' },
      exclude: true,
    },
    // negated / multi priority is not a single-value Pages Priority leaf.
    { kind: 'priority', values: ['1'], exclude: true },
    { kind: 'priority', values: ['1', '2'], exclude: false },
    // created/lastEdited date fields are carried by other canonical kinds here.
    { kind: 'date', field: 'created', predicate: { type: 'IsNull' } },
    { kind: 'date', field: 'lastEdited', predicate: { type: 'IsNull' } },
  ]
  for (const p of nonPages) {
    it(`returns null for ${p.kind}${'by' in p ? `/${p.by}` : ''}${
      'field' in p ? `/${p.field}` : ''
    }${'exclude' in p && p.exclude ? '/exclude' : ''}`, () => {
      expect(canonicalToFilterPrimitive(p)).toBeNull()
    })
  }
})

describe('pageBrowser allow-list covers every PageBrowser-built category', () => {
  it('every emitted category maps to an allow-listed kind', () => {
    const kinds = new Set<string>()
    for (const { filter } of PAGE_BROWSER_FILTERS) {
      const canonical = filterPrimitiveToCanonical(filter)
      if (canonical) kinds.add(canonical.kind)
    }
    for (const k of kinds) {
      expect(FILTER_SURFACE_ALLOWLIST.pageBrowser).toContain(k)
    }
  })
})
