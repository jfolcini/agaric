/**
 * Unit tests for DonePanel pure helpers.
 *
 * These cover the building blocks used by `DonePanel`'s data-fetch effects and
 * its render-time grouping pass. Keeping them pure makes the effects testable
 * in isolation and keeps their cognitive complexity below the oxlint eslint/complexity threshold.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import {
  collectUniqueParentIds,
  groupBlocksByPage,
  mergeResolvedTitles,
} from '@/components/agenda/DonePanel.helpers'
import type { ResolvedBlock } from '@/lib/tauri'

// `filterDoneBlocks` and its tests retired. The
// empty-content / excluded-parent filters now live in SQL via
// `query_by_property`'s `content_non_empty` / `exclude_parent_id`
// parameters; the DonePanel test suite covers the new behaviour
// end-to-end (assertions on the IPC argument shape + `totalCount`).

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

  it('sorts items by raw codepoint descending, not locale collation (#1539)', () => {
    // The panel must order ids most-recent-first using a raw binary (codepoint)
    // comparison, NOT `localeCompare` — locale collation is locale-sensitive and
    // not guaranteed to follow codepoint order. These ids are chosen so the two
    // comparators DIVERGE: in raw codepoint order uppercase (U+0041..) precedes
    // lowercase (U+0061..), whereas ICU collation interleaves case. A regression
    // back to `localeCompare` reorders this set, so the assertion is revert-
    // sensitive across locales.
    const blocks = [
      makeBlock({ id: 'idZ', page_id: 'P1' }),
      makeBlock({ id: 'idA', page_id: 'P1' }),
      makeBlock({ id: 'idz', page_id: 'P1' }),
      makeBlock({ id: 'ida', page_id: 'P1' }),
    ]
    const titles = new Map([['P1', 'Page One']])
    const groups = groupBlocksByPage(blocks, titles, untitled)
    const ids = groups[0]?.items.map((b) => b.id) ?? []
    // Descending codepoint order: lowercase (97/122) outranks uppercase (65/90),
    // so 'idz' > 'ida' > 'idZ' > 'idA'. `localeCompare` would NOT produce this.
    expect(ids).toEqual(['idz', 'ida', 'idZ', 'idA'])
    // Confirm we are not merely matching whatever `localeCompare` does — the
    // expected order must differ from the descending-localeCompare order.
    const localeOrder = [...blocks].map((b) => b.id).toSorted((a, b) => b.localeCompare(a))
    expect(localeOrder).not.toEqual(ids)
    // Strict total order: re-running on a different input permutation is stable.
    const reSorted = groupBlocksByPage(blocks.toReversed(), titles, untitled)
    expect(reSorted[0]?.items.map((b) => b.id)).toEqual(ids)
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
