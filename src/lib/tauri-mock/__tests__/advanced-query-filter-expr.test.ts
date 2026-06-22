/**
 * Mock `run_advanced_query` FLAT-path `FilterExpr` interpreter (P2 prereq).
 *
 * The mock now INTERPRETS the wire `FilterExpr` tree against the seeded block
 * store instead of returning an always-empty page. Two layers are covered:
 *   1. `metaRowMatchesExpr` — the pure And/Or/Not/Leaf boolean composition over
 *      the conformance-guarded per-primitive matrix (`metaRowMatchesFilter`).
 *      The per-primitive faithfulness is pinned elsewhere
 *      (`filter-primitive-conformance.test.ts`); this asserts ONLY the
 *      combinator identities (empty-And ⇒ TRUE, empty-Or ⇒ FALSE, Not ⇒
 *      complement).
 *   2. The `run_advanced_query` handler end-to-end: space scoping, the matched
 *      block rows, and keyset pagination.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch, metaRowMatchesExpr, type PageMetaRow } from '../handlers'
import { blockTags, blocks, makeBlock, opLog, properties, propertyDefs, seedBlocks } from '../seed'

const SPACE_A = 'SPACE_A'.padStart(26, '0')
const SPACE_B = 'SPACE_B'.padStart(26, '0')

/** Deterministic 26-char block id from a short numeric-ish label. */
function id(label: string): string {
  return label.padStart(26, '0')
}

/** Reset every mock store to empty (mirrors the conformance harness). */
function clearMock(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
}

/** Stamp a block's `space` property on its owning page (what `fbqInSpace` reads). */
function setSpace(blockId: string, spaceId: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set('space', {
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  })
}

/** A minimal `PageMetaRow` carrying just the priority the composition tests read. */
function rowWithPriority(rowId: string, priority: string | null): PageMetaRow {
  return {
    id: rowId,
    blockType: 'page',
    content: null,
    parentId: null,
    position: null,
    deletedAt: null,
    todoState: null,
    priority,
    dueDate: null,
    scheduledDate: null,
    pageId: rowId,
    lastModifiedAt: null,
    inboundLinkCount: 0,
    childBlockCount: 0,
    hasOutboundLink: false,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
}

const HIGH = { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } }
const LOW = { type: 'Leaf', primitive: { type: 'Priority', values: ['low'] } }

describe('metaRowMatchesExpr — boolean composition', () => {
  const high = rowWithPriority(id('1'), 'high')
  const low = rowWithPriority(id('2'), 'low')

  it('Leaf delegates to the per-primitive matcher', () => {
    expect(metaRowMatchesExpr(high, HIGH)).toBe(true)
    expect(metaRowMatchesExpr(low, HIGH)).toBe(false)
  })

  it('empty And is TRUE; empty Or is FALSE (engine identities)', () => {
    expect(metaRowMatchesExpr(high, { type: 'And', children: [] })).toBe(true)
    expect(metaRowMatchesExpr(high, { type: 'Or', children: [] })).toBe(false)
  })

  it('And requires every child; Or requires at least one', () => {
    expect(metaRowMatchesExpr(high, { type: 'And', children: [HIGH, LOW] })).toBe(false)
    expect(metaRowMatchesExpr(high, { type: 'Or', children: [HIGH, LOW] })).toBe(true)
    expect(metaRowMatchesExpr(low, { type: 'Or', children: [HIGH, LOW] })).toBe(true)
  })

  it('Not is the set complement', () => {
    expect(metaRowMatchesExpr(high, { type: 'Not', child: HIGH })).toBe(false)
    expect(metaRowMatchesExpr(low, { type: 'Not', child: HIGH })).toBe(true)
  })
})

describe('run_advanced_query — FLAT FilterExpr interpretation', () => {
  const PAGE_A = id('A0')
  const B1 = id('B1') // high
  const B2 = id('B2') // low
  const B3 = id('B3') // high + tag T1
  const TAG_T1 = id('T1')
  const PAGE_B = id('C0')
  const B4 = id('B4') // high, but in SPACE_B

  beforeEach(() => {
    clearMock()
    // Space A: a page + three child blocks.
    blocks.set(PAGE_A, makeBlock(PAGE_A, 'page', 'Page A', null, 1))
    setSpace(PAGE_A, SPACE_A)
    for (const [blockId, priority] of [
      [B1, 'high'],
      [B2, 'low'],
      [B3, 'high'],
    ] as const) {
      const b = makeBlock(blockId, 'text', null, PAGE_A, 1)
      b['page_id'] = PAGE_A
      b['priority'] = priority
      blocks.set(blockId, b)
    }
    blockTags.set(B3, new Set([TAG_T1]))

    // Space B: a page + one high-priority block (must never leak into Space A).
    blocks.set(PAGE_B, makeBlock(PAGE_B, 'page', 'Page B', null, 1))
    setSpace(PAGE_B, SPACE_B)
    const b4 = makeBlock(B4, 'text', null, PAGE_B, 1)
    b4['page_id'] = PAGE_B
    b4['priority'] = 'high'
    blocks.set(B4, b4)
  })

  function runIds(filter: Record<string, unknown> | undefined): string[] {
    const res = dispatch('run_advanced_query', {
      request: { spaceId: SPACE_A, ...(filter ? { filter } : {}) },
    }) as { rows: Array<Record<string, unknown>> }
    return res.rows.map((r) => r['id'] as string).toSorted()
  }

  it('a filterless query returns every block in the space (incl. the page)', () => {
    expect(runIds(undefined)).toEqual([PAGE_A, B1, B2, B3].toSorted())
  })

  it('scopes to the requested space (Space B blocks never appear)', () => {
    expect(runIds(undefined)).not.toContain(B4)
  })

  it('a Priority leaf filters to matching blocks', () => {
    expect(runIds({ type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } })).toEqual(
      [B1, B3].toSorted(),
    )
  })

  it('And intersects a priority leaf with a tag leaf', () => {
    expect(
      runIds({
        type: 'And',
        children: [
          { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
          { type: 'Leaf', primitive: { type: 'Tag', tag: TAG_T1 } },
        ],
      }),
    ).toEqual([B3])
  })

  it('Or unions two leaves', () => {
    expect(
      runIds({
        type: 'Or',
        children: [
          { type: 'Leaf', primitive: { type: 'Priority', values: ['low'] } },
          { type: 'Leaf', primitive: { type: 'Tag', tag: TAG_T1 } },
        ],
      }),
    ).toEqual([B2, B3].toSorted())
  })

  it('Not returns the complement within the space', () => {
    // Not(priority=high) ⇒ the page (null priority) + the low block.
    expect(
      runIds({
        type: 'Not',
        child: { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
      }),
    ).toEqual([PAGE_A, B2].toSorted())
  })

  it('keyset-paginates over the id order', () => {
    const page1 = dispatch('run_advanced_query', {
      request: { spaceId: SPACE_A, limit: 2 },
    }) as {
      rows: Array<Record<string, unknown>>
      hasMore: boolean
      nextCursor: string | null
      totalCount: number | null
    }
    expect(page1.rows).toHaveLength(2)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).not.toBeNull()
    expect(page1.totalCount).toBe(4)

    const page2 = dispatch('run_advanced_query', {
      request: { spaceId: SPACE_A, limit: 2, cursor: page1.nextCursor },
    }) as { rows: Array<Record<string, unknown>>; hasMore: boolean; totalCount: number | null }
    expect(page2.rows).toHaveLength(2)
    expect(page2.hasMore).toBe(false)
    expect(page2.totalCount).toBeNull()

    // The two pages together cover the full filtered set with no overlap.
    const all = [...page1.rows, ...page2.rows].map((r) => r['id'] as string).toSorted()
    expect(all).toEqual([PAGE_A, B1, B2, B3].toSorted())
  })
})
