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
 *   3. `Not` over each leaf the mock once answered with a silent `true` (#6054
 *      D2), and the leaves the advanced-query surface refuses.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import {
  dispatch,
  metaRowMatchesExpr,
  metaRowMatchesFilter,
  type PageMetaRow,
} from '@/lib/tauri-mock/handlers'
import { buildPageMetaRow } from '@/lib/tauri-mock/handlers/shared'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

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

  /** Like `runIds`, but preserves the handler's row order (no `.toSorted()`). */
  function runIdsOrdered(filter: Record<string, unknown> | undefined): string[] {
    const res = dispatch('run_advanced_query', {
      request: { spaceId: SPACE_A, ...(filter ? { filter } : {}) },
    }) as { rows: Array<Record<string, unknown>> }
    return res.rows.map((r) => r['id'] as string)
  }

  it('a filterless query returns every block in the space (incl. the page)', () => {
    expect(runIds(undefined)).toEqual([PAGE_A, B1, B2, B3].toSorted())
  })

  it('scopes to the requested space (Space B blocks never appear)', () => {
    expect(runIds(undefined)).not.toContain(B4)
  })

  // #3821 defect 1 — `blockType` on the row the `FilterExpr` interpreter
  // evaluates against must mirror the block's REAL `block_type`, not a
  // hardcoded `'page'` constant (which made `BlockType` a no-op: every row
  // compared equal to the filter's `'page'` value regardless of its actual
  // type). PAGE_A is a `page`; B1/B2/B3 are `text` children.
  it('a BlockType leaf filters to matching blocks (not a no-op over block_type)', () => {
    expect(runIds({ type: 'Leaf', primitive: { type: 'BlockType', values: ['page'] } })).toEqual([
      PAGE_A,
    ])
    expect(runIds({ type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } })).toEqual(
      [B1, B2, B3].toSorted(),
    )
    // No `values: ['tag']` leg: the space seeds no `tag` block, so it returns
    // `[]` with AND without the fix — decoration, not coverage. (A
    // page/text PARTITION assertion is vacuous here for the same reason:
    // under the bug `['page']` matches all four and `['text']` matches none,
    // so the union still equals the filterless set. Both legs above are
    // individually discriminating, which is what actually pins the fix.)
  })

  // #3821 defect 2 — the FLAT path's default order is the backend's
  // `b.id DESC` recency keyset (`agaric-store/src/query/engine.rs`: no
  // `sort` + no full-text ⇒ `b.id DESC`), NOT `b.id ASC`.
  it('defaults to id DESC (the backend recency keyset), not id ASC', () => {
    expect(runIdsOrdered(undefined)).toEqual([PAGE_A, B1, B2, B3].toSorted().toReversed())
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

describe('run_advanced_query — Not over every leaf it admits (#6054 D2)', () => {
  const PAGE = id('P0')
  const PARENT = id('P1') // TODO, parent of CHILD
  const CHILD = id('P2')
  const LINKER = id('P3') // links to CHILD
  // A literal ULID dated 2025-06-15; the padded ids date to the epoch.
  const DATED = '01JXRE5J000000000000000001'
  const ALL = [PAGE, PARENT, CHILD, LINKER, DATED].toSorted()

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 1))
    setSpace(PAGE, SPACE_A)
    for (const [blockId, parent, content] of [
      [PARENT, PAGE, 'parent'],
      [CHILD, PARENT, 'child'],
      [LINKER, PAGE, `see [[${CHILD}]]`],
      [DATED, PAGE, 'dated'],
    ] as const) {
      const b = makeBlock(blockId, 'content', content, parent, 1)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
    ;(blocks.get(PARENT) as Record<string, unknown>)['todo_state'] = 'TODO'
  })

  function runIds(filter: Record<string, unknown>): string[] {
    const res = dispatch('run_advanced_query', {
      request: { spaceId: SPACE_A, filter },
    }) as { rows: Array<Record<string, unknown>> }
    return res.rows.map((r) => r['id'] as string).toSorted()
  }

  const leaf = (primitive: Record<string, unknown>) => ({ type: 'Leaf', primitive })
  const not = (child: Record<string, unknown>) => ({ type: 'Not', child })
  const others = (...kept: string[]) => ALL.filter((x) => !kept.includes(x))

  it('ChildOf matches the direct children; Not keeps the rows with a NULL parent', () => {
    const childOf = leaf({ type: 'ChildOf', parent: PARENT })
    expect(runIds(childOf)).toEqual([CHILD])
    expect(runIds(not(childOf))).toEqual(others(CHILD))
  })

  it("Space matches the blocks of the space's pages; Not of it is empty", () => {
    expect(runIds(leaf({ type: 'Space', space_id: SPACE_A }))).toEqual(ALL)
    expect(runIds(not(leaf({ type: 'Space', space_id: SPACE_A })))).toEqual([])
    expect(runIds(not(leaf({ type: 'Space', space_id: SPACE_B })))).toEqual(ALL)
  })

  it("Created compares the id's ULID time; Not keeps the older rows", () => {
    const created = leaf({ type: 'Created', after: '2025-01-01', before: null })
    expect(runIds(created)).toEqual([DATED])
    expect(runIds(not(created))).toEqual(others(DATED))
    expect(runIds(leaf({ type: 'Created', after: null, before: '2025-06-15T00:00:00Z' }))).toEqual(
      others(DATED),
    )
  })

  it('Created refuses a bound that is not a date, under a Not too', () => {
    expect(() => runIds(not(leaf({ type: 'Created', after: '2025-13-01', before: null })))).toThrow(
      expect.objectContaining({ kind: 'validation', code: 'InvalidDateFilter' }),
    )
  })

  it('LinkedFrom matches the blocks the source links to; Not keeps the rest', () => {
    const linkedFrom = leaf({ type: 'LinkedFrom', source: LINKER })
    expect(runIds(linkedFrom)).toEqual([CHILD])
    expect(runIds(not(linkedFrom))).toEqual(others(CHILD))
  })

  it('HasParentMatching judges the parent row; Not keeps the rows without one', () => {
    const hpm = leaf({
      type: 'HasParentMatching',
      matcher: leaf({ type: 'State', values: ['TODO'] }),
    })
    expect(runIds(hpm)).toEqual([CHILD])
    expect(runIds(not(hpm))).toEqual(others(CHILD))
  })

  it("HasParentMatching reads the parent's last-edited stamp, not the outer row's", () => {
    const rolling = leaf({
      type: 'HasParentMatching',
      matcher: leaf({ type: 'LastEdited', spec: { type: 'Rolling', days: 3650 } }),
    })
    const now = (): string => new Date().toISOString()
    const rowOf = (blockId: string) =>
      buildPageMetaRow(blocks.get(blockId) as Record<string, unknown>, [], [])
    // CHILD was "just edited", but its parent PARENT dates to the epoch.
    expect(metaRowMatchesExpr(rowOf(CHILD), rolling, now)).toBe(false)
    // A row under DATED (2025-06-15) matches whatever its own stamp says.
    const under = makeBlock(id('P4'), 'content', 'under', DATED, 1)
    blocks.set(id('P4'), under)
    expect(metaRowMatchesExpr(rowOf(id('P4')), rolling, () => null)).toBe(true)
  })

  it('metaRowMatchesFilter refuses a Search-only leaf rather than matching every row', () => {
    expect(() => metaRowMatchesFilter(rowWithPriority(PAGE, null), { type: 'Regex' })).toThrow(
      expect.objectContaining({ kind: 'validation', code: 'InvalidFilter' }),
    )
  })

  it('refuses a leaf the surface does not admit, under a Not and inside a matcher', () => {
    const invalidFilter = expect.objectContaining({ kind: 'validation', code: 'InvalidFilter' })
    expect(() => runIds(not(leaf({ type: 'Regex', pattern: 'x' })))).toThrow(invalidFilter)
    expect(() =>
      runIds(leaf({ type: 'HasParentMatching', matcher: leaf({ type: 'Orphan' }) })),
    ).toThrow(invalidFilter)
  })
})
