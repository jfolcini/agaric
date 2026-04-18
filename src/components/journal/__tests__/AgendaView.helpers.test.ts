/**
 * Tests for AgendaView pure helpers.
 *
 * Covers:
 *  1. collectUniquePageIds — dedup, null filtering, order preservation, empty
 *  2. buildPageTitleMap — null title fallback, duplicate last-wins, empty
 *  3. processFilterResult — 200-cap, pageIds derived, hasMore/cursor pass-through
 */

import { describe, expect, it } from 'vitest'
import { makeBlock } from '../../../__tests__/fixtures'
import type { ExecuteFiltersResult } from '../../../lib/agenda-filters'
import type { ResolvedBlock } from '../../../lib/tauri'
import {
  AGENDA_MAX_BLOCKS,
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

  it('caps blocks at AGENDA_MAX_BLOCKS (200)', () => {
    expect(AGENDA_MAX_BLOCKS).toBe(200)
    const manyBlocks = Array.from({ length: 250 }, (_, i) =>
      makeBlock({ id: `B${i}`, page_id: `P${i % 5}` }),
    )
    const result: ExecuteFiltersResult = { blocks: manyBlocks, hasMore: false, cursor: null }
    const outcome = processFilterResult(result)
    expect(outcome.blocks).toHaveLength(AGENDA_MAX_BLOCKS)
    expect(outcome.blocks[0]?.id).toBe('B0')
    expect(outcome.blocks[199]?.id).toBe('B199')
  })

  it('returns unique pageIds derived from the capped block window', () => {
    // Blocks 0..199 have page_ids P0..P4 cycling; blocks 200..249 have P5..P9
    // that would never appear after the 200-cap.
    const blocks = Array.from({ length: 250 }, (_, i) => {
      const pageIndex = i < 200 ? i % 5 : 5 + (i % 5)
      return makeBlock({ id: `B${i}`, page_id: `P${pageIndex}` })
    })
    const outcome = processFilterResult({ blocks, hasMore: false, cursor: null })
    expect(outcome.pageIds).toEqual(['P0', 'P1', 'P2', 'P3', 'P4'])
  })

  it('leaves blocks untouched when under the cap', () => {
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
