/**
 * Tests for AgendaView pure helpers.
 *
 * Covers:
 *  1. collectUniquePageIds — dedup, null filtering, order preservation, empty
 *  2. buildPageTitleMap — null title fallback, duplicate last-wins, empty
 *  3. processFilterResult — no truncation (#721), pageIds derived, hasMore/cursor pass-through
 *  4. appendUniqueBlocks — load-more dedupe across merged source windows (#721)
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../../__tests__/fixtures'
import type { ExecuteFiltersResult } from '../../../lib/agenda-filters'
import type { ResolvedBlock } from '../../../lib/tauri'
import {
  appendUniqueBlocks,
  buildPageTitleMap,
  collectUniquePageIds,
  FALLBACK_PAGE_TITLE,
  processFilterResult,
} from '../AgendaView.helpers'

describe('collectUniquePageIds', () => {
  it('returns an empty array for no blocks', () => {
    expect(collectUniquePageIds([])).toEqual([])
  })

  it('collects page_ids preserving first-seen order', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B2', page_id: 'PAGE_B' }),
      makeBlock({ id: 'B3', page_id: 'PAGE_C' }),
    ]
    expect(collectUniquePageIds(blocks)).toEqual(['PAGE_A', 'PAGE_B', 'PAGE_C'])
  })

  it('deduplicates repeated page_ids', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B2', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B3', page_id: 'PAGE_B' }),
      makeBlock({ id: 'B4', page_id: 'PAGE_A' }),
    ]
    const ids = collectUniquePageIds(blocks)
    expect(ids).toHaveLength(2)
    expect(ids).toEqual(['PAGE_A', 'PAGE_B'])
  })

  it('excludes null page_ids', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: null }),
      makeBlock({ id: 'B2', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B3', page_id: null }),
    ]
    expect(collectUniquePageIds(blocks)).toEqual(['PAGE_A'])
  })

  it('returns an empty array when every block has null page_id', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: null }), makeBlock({ id: 'B2', page_id: null })]
    expect(collectUniquePageIds(blocks)).toEqual([])
  })

  it('does not mutate the input', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B2', page_id: 'PAGE_A' }),
    ]
    const snapshot = JSON.stringify(blocks)
    collectUniquePageIds(blocks)
    expect(JSON.stringify(blocks)).toBe(snapshot)
  })
})

describe('buildPageTitleMap', () => {
  it('returns an empty map for no resolved entries', () => {
    const map = buildPageTitleMap([])
    expect(map.size).toBe(0)
  })

  it('builds an id → title map from resolved entries', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE_A', title: 'Alpha', block_type: 'page', deleted: false },
      { id: 'PAGE_B', title: 'Beta', block_type: 'page', deleted: false },
    ]
    const map = buildPageTitleMap(resolved)
    expect(map.size).toBe(2)
    expect(map.get('PAGE_A')).toBe('Alpha')
    expect(map.get('PAGE_B')).toBe('Beta')
  })

  it('substitutes the fallback title when title is null', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE_A', title: null, block_type: 'page', deleted: false },
    ]
    const map = buildPageTitleMap(resolved)
    expect(map.get('PAGE_A')).toBe(FALLBACK_PAGE_TITLE)
    expect(FALLBACK_PAGE_TITLE).toBe('Untitled')
  })

  it('keeps the last title on duplicate ids', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE_A', title: 'First', block_type: 'page', deleted: false },
      { id: 'PAGE_A', title: 'Second', block_type: 'page', deleted: false },
    ]
    const map = buildPageTitleMap(resolved)
    expect(map.size).toBe(1)
    expect(map.get('PAGE_A')).toBe('Second')
  })
})

describe('processFilterResult', () => {
  it('passes hasMore and cursor through verbatim', () => {
    const result: ExecuteFiltersResult = {
      blocks: [],
      hasMore: true,
      cursor: 'cursor_abc',
    }
    const outcome = processFilterResult(result)
    expect(outcome.hasMore).toBe(true)
    expect(outcome.cursor).toBe('cursor_abc')
    expect(outcome.blocks).toEqual([])
    expect(outcome.pageIds).toEqual([])
  })

  // #721 — the old 200-row slice silently dropped rows the pagination
  // cursor had already moved past (merge order dropped scheduled-only
  // and undated blocks preferentially). Every fetch path is now
  // backend-windowed, so processFilterResult must NOT truncate.
  it('#721: does not truncate large result windows', () => {
    const manyBlocks = Array.from({ length: 250 }, (_, i) =>
      makeBlock({ id: `B${i}`, page_id: `P${i % 5}` }),
    )
    const result: ExecuteFiltersResult = { blocks: manyBlocks, hasMore: false, cursor: null }
    const outcome = processFilterResult(result)
    expect(outcome.blocks).toHaveLength(250)
    expect(outcome.blocks[249]?.id).toBe('B249')
  })

  it('returns unique pageIds derived from ALL blocks (#721: no capped window)', () => {
    const blocks = Array.from({ length: 250 }, (_, i) => {
      const pageIndex = i < 200 ? i % 5 : 5 + (i % 5)
      return makeBlock({ id: `B${i}`, page_id: `P${pageIndex}` })
    })
    const outcome = processFilterResult({ blocks, hasMore: false, cursor: null })
    expect(outcome.pageIds).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'])
  })

  it('passes small block lists through untouched', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'PAGE_A' }),
      makeBlock({ id: 'B2', page_id: 'PAGE_B' }),
    ]
    const outcome = processFilterResult({ blocks, hasMore: false, cursor: null })
    expect(outcome.blocks).toHaveLength(2)
    expect(outcome.pageIds).toEqual(['PAGE_A', 'PAGE_B'])
  })

  it('returns empty pageIds when all blocks have null page_id', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: null }), makeBlock({ id: 'B2', page_id: null })]
    const outcome = processFilterResult({ blocks, hasMore: false, cursor: null })
    expect(outcome.blocks).toHaveLength(2)
    expect(outcome.pageIds).toEqual([])
  })

  it('does not mutate the input blocks array', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: 'PAGE_A' })]
    const snapshot = JSON.stringify(blocks)
    processFilterResult({ blocks, hasMore: false, cursor: null })
    expect(JSON.stringify(blocks)).toBe(snapshot)
  })
})

describe('appendUniqueBlocks (#721)', () => {
  it('appends new blocks after the existing ones', () => {
    const prev = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' })]
    const next = [makeBlock({ id: 'B3' })]
    expect(appendUniqueBlocks(prev, next).map((b) => b.id)).toEqual(['B1', 'B2', 'B3'])
  })

  it('drops blocks already present (cross-window duplicate from a second source)', () => {
    // A block with both due AND scheduled dates can arrive from the
    // due_date window on page 1 and the scheduled_date window on page 2.
    const both = makeBlock({ id: 'BOTH', due_date: '2025-01-15', scheduled_date: '2025-01-10' })
    const prev = [both, makeBlock({ id: 'B1' })]
    const next = [makeBlock({ id: 'BOTH' }), makeBlock({ id: 'B2' })]
    expect(appendUniqueBlocks(prev, next).map((b) => b.id)).toEqual(['BOTH', 'B1', 'B2'])
  })

  it('dedupes within the appended batch itself', () => {
    const next = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B1' })]
    expect(appendUniqueBlocks([], next).map((b) => b.id)).toEqual(['B1'])
  })

  it('does not mutate either input', () => {
    const prev = [makeBlock({ id: 'B1' })]
    const next = [makeBlock({ id: 'B2' })]
    const prevSnap = JSON.stringify(prev)
    const nextSnap = JSON.stringify(next)
    appendUniqueBlocks(prev, next)
    expect(JSON.stringify(prev)).toBe(prevSnap)
    expect(JSON.stringify(next)).toBe(nextSnap)
  })
})
