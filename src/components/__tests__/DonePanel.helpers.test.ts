/**
 * Unit tests for DonePanel pure helpers (MAINT-58).
 *
 * These cover the building blocks used by `DonePanel`'s data-fetch effects and
 * its render-time grouping pass. Keeping them pure makes the effects testable
 * in isolation and keeps their cognitive complexity below the Biome threshold.
 */

import { describe, expect, it } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { ResolvedBlock } from '../../lib/tauri'
import {
  collectUniqueParentIds,
  filterDoneBlocks,
  groupBlocksByPage,
  mergeResolvedTitles,
} from '../DonePanel.helpers'

// ---------------------------------------------------------------------------
// filterDoneBlocks
// ---------------------------------------------------------------------------

describe('filterDoneBlocks', () => {
  it('keeps blocks with non-empty content when no excludePageId is given', () => {
    const input = [
      makeBlock({ id: 'B1', content: 'hello' }),
      makeBlock({ id: 'B2', content: 'world' }),
    ]
    const out = filterDoneBlocks(input, undefined)
    expect(out).toHaveLength(2)
    expect(out.map((b) => b.id)).toEqual(['B1', 'B2'])
  })

  it('drops blocks with null, empty-string, or whitespace-only content (UX-129)', () => {
    const input = [
      makeBlock({ id: 'B1', content: 'keep' }),
      makeBlock({ id: 'B2', content: null }),
      makeBlock({ id: 'B3', content: '' }),
      makeBlock({ id: 'B4', content: '   ' }),
      makeBlock({ id: 'B5', content: '\t\n' }),
      makeBlock({ id: 'B6', content: 'also keep' }),
    ]
    const out = filterDoneBlocks(input, undefined)
    expect(out).toHaveLength(2)
    expect(out.map((b) => b.id)).toEqual(['B1', 'B6'])
  })

  it('drops blocks whose parent_id matches excludePageId (B-74)', () => {
    const input = [
      makeBlock({ id: 'B1', parent_id: 'PAGE_1', content: 'same page' }),
      makeBlock({ id: 'B2', parent_id: 'PAGE_2', content: 'other page' }),
      makeBlock({ id: 'B3', parent_id: 'PAGE_1', content: 'also same' }),
      makeBlock({ id: 'B4', parent_id: null, content: 'no parent' }),
    ]
    const out = filterDoneBlocks(input, 'PAGE_1')
    expect(out).toHaveLength(2)
    expect(out.map((b) => b.id)).toEqual(['B2', 'B4'])
  })

  it('returns an empty array when input is empty', () => {
    expect(filterDoneBlocks([], undefined)).toHaveLength(0)
    expect(filterDoneBlocks([], 'PAGE_1')).toHaveLength(0)
  })

  it('does not mutate the input array', () => {
    const input = [makeBlock({ id: 'B1', content: 'keep' }), makeBlock({ id: 'B2', content: null })]
    const snapshot = input.slice()
    filterDoneBlocks(input, 'PAGE_1')
    expect(input).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// collectUniqueParentIds
// ---------------------------------------------------------------------------

describe('collectUniqueParentIds', () => {
  it('returns the deduped non-null page_ids in first-seen order', () => {
    const input = [
      makeBlock({ id: 'B1', page_id: 'P1' }),
      makeBlock({ id: 'B2', page_id: 'P2' }),
      makeBlock({ id: 'B3', page_id: 'P1' }),
      makeBlock({ id: 'B4', page_id: 'P3' }),
      makeBlock({ id: 'B5', page_id: 'P2' }),
    ]
    const ids = collectUniqueParentIds(input)
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(['P1', 'P2', 'P3'])
  })

  it('filters out blocks with a null page_id', () => {
    const input = [
      makeBlock({ id: 'B1', page_id: null }),
      makeBlock({ id: 'B2', page_id: 'P1' }),
      makeBlock({ id: 'B3', page_id: null }),
    ]
    const ids = collectUniqueParentIds(input)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBe('P1')
  })

  it('returns an empty array when every block has null page_id', () => {
    const input = [makeBlock({ id: 'B1', page_id: null }), makeBlock({ id: 'B2', page_id: null })]
    expect(collectUniqueParentIds(input)).toHaveLength(0)
  })

  it('returns an empty array on empty input', () => {
    expect(collectUniqueParentIds([])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// mergeResolvedTitles
// ---------------------------------------------------------------------------

describe('mergeResolvedTitles', () => {
  const untitled = 'Untitled'

  it('merges resolved titles into the existing map', () => {
    const prev = new Map([['P1', 'Original']])
    const resolved: ResolvedBlock[] = [
      { id: 'P2', title: 'New Title', block_type: 'page', deleted: false },
    ]
    const next = mergeResolvedTitles(prev, resolved, untitled)
    expect(next.size).toBe(2)
    expect(next.get('P1')).toBe('Original')
    expect(next.get('P2')).toBe('New Title')
  })

  it('overwrites existing entries with freshly-resolved titles', () => {
    const prev = new Map([['P1', 'Stale']])
    const resolved: ResolvedBlock[] = [
      { id: 'P1', title: 'Fresh', block_type: 'page', deleted: false },
    ]
    const next = mergeResolvedTitles(prev, resolved, untitled)
    expect(next.size).toBe(1)
    expect(next.get('P1')).toBe('Fresh')
  })

  it('falls back to untitledLabel when title is null', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'P1', title: null, block_type: 'page', deleted: false },
    ]
    const next = mergeResolvedTitles(new Map(), resolved, untitled)
    expect(next.size).toBe(1)
    expect(next.get('P1')).toBe(untitled)
  })

  it('does not mutate the input map', () => {
    const prev = new Map([['P1', 'Original']])
    const resolved: ResolvedBlock[] = [
      { id: 'P2', title: 'Added', block_type: 'page', deleted: false },
    ]
    const next = mergeResolvedTitles(prev, resolved, untitled)
    expect(prev.size).toBe(1)
    expect(prev.has('P2')).toBe(false)
    expect(next).not.toBe(prev)
  })

  it('returns a fresh empty map when both inputs are empty', () => {
    const prev = new Map<string, string>()
    const next = mergeResolvedTitles(prev, [], untitled)
    expect(next.size).toBe(0)
    expect(next).not.toBe(prev)
  })
})

// ---------------------------------------------------------------------------
// groupBlocksByPage
// ---------------------------------------------------------------------------

describe('groupBlocksByPage', () => {
  const untitled = 'Untitled'

  it('groups blocks by page_id and sorts groups alphabetically by title', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'P_BETA' }),
      makeBlock({ id: 'B2', page_id: 'P_ALPHA' }),
      makeBlock({ id: 'B3', page_id: 'P_BETA' }),
    ]
    const titles = new Map([
      ['P_ALPHA', 'Alpha'],
      ['P_BETA', 'Beta'],
    ])
    const groups = groupBlocksByPage(blocks, titles, untitled)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.title).toBe('Alpha')
    expect(groups[0]?.items).toHaveLength(1)
    expect(groups[1]?.title).toBe('Beta')
    expect(groups[1]?.items).toHaveLength(2)
  })

  it('sorts items within each group by id descending (ULID recency)', () => {
    const blocks = [
      makeBlock({ id: 'AAA', page_id: 'P1' }),
      makeBlock({ id: 'CCC', page_id: 'P1' }),
      makeBlock({ id: 'BBB', page_id: 'P1' }),
    ]
    const titles = new Map([['P1', 'Page One']])
    const groups = groupBlocksByPage(blocks, titles, untitled)
    expect(groups).toHaveLength(1)
    const ids = groups[0]?.items.map((b) => b.id) ?? []
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(['CCC', 'BBB', 'AAA'])
  })

  it('falls back to untitledLabel for page_ids missing from the titles map', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: 'P_UNKNOWN' })]
    const groups = groupBlocksByPage(blocks, new Map(), untitled)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe(untitled)
    expect(groups[0]?.pageId).toBe('P_UNKNOWN')
  })

  it('buckets blocks with null page_id under the synthetic __none__ bucket', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: null }), makeBlock({ id: 'B2', page_id: null })]
    const groups = groupBlocksByPage(blocks, new Map(), untitled)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pageId).toBe('__none__')
    expect(groups[0]?.title).toBe(untitled)
    expect(groups[0]?.items).toHaveLength(2)
  })

  it('returns an empty array when input is empty', () => {
    expect(groupBlocksByPage([], new Map(), untitled)).toHaveLength(0)
  })

  it('preserves block references (does not clone blocks)', () => {
    const b1 = makeBlock({ id: 'B1', page_id: 'P1' })
    const groups = groupBlocksByPage([b1], new Map([['P1', 'Title']]), untitled)
    expect(groups[0]?.items[0]).toBe(b1)
  })
})
