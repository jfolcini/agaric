/**
 * Unit coverage for the legacy → `FilterExpr` translator (P2 reroute). The
 * legacy↔rich RESULT equivalence is proven separately by
 * `hooks/__tests__/inline-query-equivalence.test.ts`; this pins the structural
 * mapping and the conservative fallback `reasons` (the cases that must stay on
 * the legacy path so a block's results never silently change).
 */

import { describe, expect, it } from 'vitest'

import {
  type InlineQueryResolveDeps,
  resolveLegacyQueryToFilterExpr,
} from '../inline-query-resolve'
import { parseQueryExpression } from '../query-utils'

/** Stub tag resolver: known prefixes → one id each, anything else → no tags. */
const TAG_IDS: Record<string, string[]> = { work: ['TAG_WORK'], home: ['TAG_HOME'] }
const deps: InlineQueryResolveDeps = {
  resolveTagPrefix: async (prefix) => TAG_IDS[prefix] ?? [],
}

async function resolve(expr: string) {
  return resolveLegacyQueryToFilterExpr(parseQueryExpression(expr), deps)
}

describe('resolveLegacyQueryToFilterExpr — structural mapping', () => {
  it('shorthand tag → And[ Or[ TagOrRef ] ] (ref-inclusive)', async () => {
    const { filterExpr, reasons } = await resolve('tag:work')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Or',
          children: [{ type: 'Leaf', primitive: { type: 'TagOrRef', tag: 'TAG_WORK' } }],
        },
      ],
    })
  })

  it('multiple tag prefixes → a SINGLE Or over the union (legacy mode:or)', async () => {
    const { filterExpr, reasons } = await resolve('tag:work tag:home')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Or',
          children: [
            { type: 'Leaf', primitive: { type: 'TagOrRef', tag: 'TAG_WORK' } },
            { type: 'Leaf', primitive: { type: 'TagOrRef', tag: 'TAG_HOME' } },
          ],
        },
      ],
    })
  })

  it('an unresolved tag prefix → empty Or (FALSE), not a fallback', async () => {
    const { filterExpr, reasons } = await resolve('tag:ghost')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({ type: 'And', children: [{ type: 'Or', children: [] }] })
  })

  it('reserved keys route to column primitives (eq)', async () => {
    expect((await resolve('property:priority=1')).filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: { type: 'Priority', values: ['1'], is_null: false, exclude: false },
        },
      ],
    })
    expect((await resolve('property:todo_state=TODO')).filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: { type: 'State', values: ['TODO'], is_null: false, exclude: false },
        },
      ],
    })
  })

  it('due_date with a date value → DueDate predicate', async () => {
    expect((await resolve('property:due_date=2025-06-01')).filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: { type: 'DueDate', predicate: { type: 'On', date: '2025-06-01' } },
        },
      ],
    })
  })

  it('custom key → HasProperty (text), date value → HasProperty (date)', async () => {
    expect((await resolve('property:context=@office')).filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: {
            type: 'HasProperty',
            key: 'context',
            predicate: { type: 'Eq', value: { type: 'Text', value: '@office' } },
          },
        },
      ],
    })
    expect((await resolve('property:deadline=2025-06-01')).filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: {
            type: 'HasProperty',
            key: 'deadline',
            predicate: { type: 'Eq', value: { type: 'Date', value: '2025-06-01' } },
          },
        },
      ],
    })
  })

  it('multiple filters compose with And', async () => {
    const { filterExpr } = await resolve('property:priority=1 tag:work')
    expect(filterExpr?.type).toBe('And')
    expect(filterExpr?.type === 'And' && filterExpr.children).toHaveLength(2)
  })

  it('backlinks → ChildOf (direct children of the target)', async () => {
    const { filterExpr, reasons } = await resolve('type:backlinks target:01ABC')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({
      type: 'And',
      children: [{ type: 'Leaf', primitive: { type: 'ChildOf', parent: '01ABC' } }],
    })
  })
})

describe('resolveLegacyQueryToFilterExpr — conservative fallback (legacy)', () => {
  const fallbackCases: Array<[string, string]> = [
    ['property:priority>1', 'property-not-expressible:priority:gt'],
    ['property:todo_state!=DONE', 'property-not-expressible:todo_state:neq'],
    // `!=` on a reserved DATE key stays legacy (no NotOn predicate + NULL semantics).
    ['property:due_date!=2025-01-01', 'property-not-expressible:due_date:neq'],
    ['type:invalid', 'no-translatable-content'],
  ]

  for (const [expr, reason] of fallbackCases) {
    it(`${expr} → legacy fallback (${reason})`, async () => {
      const { filterExpr, reasons } = await resolve(expr)
      expect(filterExpr).toBeNull()
      expect(reasons).toContain(reason)
    })
  }

  it('custom-key non-eq IS expressible (HasProperty supports comparisons)', async () => {
    const { filterExpr, reasons } = await resolve('property:label>=beta')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'Leaf',
          primitive: {
            type: 'HasProperty',
            key: 'label',
            predicate: { type: 'Gte', value: { type: 'Text', value: 'beta' } },
          },
        },
      ],
    })
  })

  it('custom-key != → presence-requiring inequality (Exists AND Ne)', async () => {
    const { filterExpr, reasons } = await resolve('property:context!=beta')
    expect(reasons).toEqual([])
    expect(filterExpr).toEqual({
      type: 'And',
      children: [
        {
          type: 'And',
          children: [
            {
              type: 'Leaf',
              primitive: { type: 'HasProperty', key: 'context', predicate: { type: 'Exists' } },
            },
            {
              type: 'Leaf',
              primitive: {
                type: 'HasProperty',
                key: 'context',
                predicate: { type: 'Ne', value: { type: 'Text', value: 'beta' } },
              },
            },
          ],
        },
      ],
    })
  })
})
