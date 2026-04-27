/**
 * Unit tests for the pure helpers extracted from useDuePanelData (MAINT-60).
 *
 * The helpers are small, side-effect-free, and deterministic — no Tauri
 * mocking, no React renderer. Each covers the happy path plus the
 * branches that the hook exercises.
 */

import { describe, expect, it } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { ResolvedBlock } from '../../lib/tauri'
import {
  applySourceFilter,
  buildTitleMap,
  collectResolveIds,
  extractUlidRefs,
} from '../useDuePanelData'

describe('applySourceFilter', () => {
  const date = '2025-06-15'

  it("excludes blocks whose due_date matches the date when sourceFilter is 'property:'", () => {
    const items = [
      makeBlock({ id: 'B1', due_date: '2025-06-15', scheduled_date: null }),
      makeBlock({ id: 'B2', due_date: null, scheduled_date: null }),
      makeBlock({ id: 'B3', due_date: '2025-06-16', scheduled_date: null }),
    ]
    const result = applySourceFilter(items, date, 'property:')
    expect(result).toHaveLength(2)
    expect(result.map((b) => b.id)).toEqual(['B2', 'B3'])
  })

  it("excludes blocks whose scheduled_date matches the date when sourceFilter is 'property:'", () => {
    const items = [
      makeBlock({ id: 'B1', due_date: null, scheduled_date: '2025-06-15' }),
      makeBlock({ id: 'B2', due_date: null, scheduled_date: '2025-06-16' }),
    ]
    const result = applySourceFilter(items, date, 'property:')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('B2')
  })

  it('returns items unchanged when sourceFilter is any other value (aside from empty-content pass)', () => {
    const items = [
      makeBlock({ id: 'B1', due_date: '2025-06-15', scheduled_date: null }),
      makeBlock({ id: 'B2', due_date: null, scheduled_date: '2025-06-15' }),
      makeBlock({ id: 'B3', due_date: null, scheduled_date: null }),
    ]
    expect(applySourceFilter(items, date, null)).toHaveLength(3)
    expect(applySourceFilter(items, date, 'column:due_date')).toHaveLength(3)
  })

  it('filters empty, whitespace-only, and null content (UX-129)', () => {
    const items = [
      makeBlock({ id: 'B1', content: 'real task' }),
      makeBlock({ id: 'B2', content: null }),
      makeBlock({ id: 'B3', content: '' }),
      makeBlock({ id: 'B4', content: '   \t\n  ' }),
      makeBlock({ id: 'B5', content: 'another task' }),
    ]
    const result = applySourceFilter(items, date, null)
    expect(result).toHaveLength(2)
    expect(result.map((b) => b.id)).toEqual(['B1', 'B5'])
  })

  it("combines the 'property:' filter with empty-content filtering", () => {
    const items = [
      makeBlock({ id: 'B1', due_date: '2025-06-15', content: 'matches date' }),
      makeBlock({ id: 'B2', due_date: null, content: '' }),
      makeBlock({ id: 'B3', due_date: null, content: 'keep me' }),
    ]
    const result = applySourceFilter(items, date, 'property:')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('B3')
  })

  it('returns an empty array when given an empty input', () => {
    expect(applySourceFilter([], date, 'property:')).toHaveLength(0)
    expect(applySourceFilter([], date, null)).toHaveLength(0)
  })
})

describe('collectResolveIds', () => {
  it('dedupes page_id + inline ULID refs into a single array', () => {
    const ULID_A = '01ABCDEFGHJKLMNPQRSTUVWXYZ'
    const ULID_B = '01ZYXWVUTSRQPNMLKJHGFEDCBA'
    const blocks = [
      makeBlock({ id: 'B1', page_id: 'PAGE1', content: `Link to [[${ULID_A}]]` }),
      makeBlock({ id: 'B2', page_id: 'PAGE1', content: `Another #[${ULID_B}]` }),
      makeBlock({ id: 'B3', page_id: 'PAGE2', content: 'no refs' }),
    ]
    const ids = collectResolveIds(blocks)
    // PAGE1 appears twice but should only be present once.
    expect(ids).toHaveLength(4)
    expect(new Set(ids)).toEqual(new Set(['PAGE1', 'PAGE2', ULID_A, ULID_B]))
  })

  it('filters out null page_ids', () => {
    const blocks = [
      makeBlock({ id: 'B1', page_id: null, content: 'plain' }),
      makeBlock({ id: 'B2', page_id: 'PAGE1', content: 'plain' }),
      makeBlock({ id: 'B3', page_id: null, content: 'plain' }),
    ]
    const ids = collectResolveIds(blocks)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBe('PAGE1')
  })

  it('includes inline ULID refs extracted from block content', () => {
    const ULID = '01ABCDEFGHJKLMNPQRSTUVWXYZ'
    const blocks = [
      makeBlock({
        id: 'B1',
        page_id: 'PAGE1',
        content: `See [[${ULID}]] and also #[${ULID}] and ((${ULID}))`,
      }),
    ]
    const ids = collectResolveIds(blocks)
    // Three references to the same ULID should collapse to one entry;
    // page_id is the second.
    expect(ids).toHaveLength(2)
    expect(new Set(ids)).toEqual(new Set(['PAGE1', ULID]))
  })

  it('handles null content without throwing', () => {
    const blocks = [makeBlock({ id: 'B1', page_id: 'PAGE1', content: null })]
    const ids = collectResolveIds(blocks)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBe('PAGE1')
  })

  it('returns an empty array when given no blocks', () => {
    expect(collectResolveIds([])).toHaveLength(0)
  })
})

describe('buildTitleMap', () => {
  it('maps resolved id → title directly when title is present', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE1', title: 'First', block_type: 'page', deleted: false },
      { id: 'PAGE2', title: 'Second', block_type: 'page', deleted: false },
    ]
    const map = buildTitleMap(resolved, 'Untitled')
    expect(map.size).toBe(2)
    expect(map.get('PAGE1')).toBe('First')
    expect(map.get('PAGE2')).toBe('Second')
  })

  it('applies the fallback when resolved title is null', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE1', title: null, block_type: 'page', deleted: false },
      { id: 'PAGE2', title: 'Real Title', block_type: 'page', deleted: false },
    ]
    const map = buildTitleMap(resolved, 'Untitled')
    expect(map.size).toBe(2)
    expect(map.get('PAGE1')).toBe('Untitled')
    expect(map.get('PAGE2')).toBe('Real Title')
  })

  it('respects a custom fallback string', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE1', title: null, block_type: 'page', deleted: false },
    ]
    const map = buildTitleMap(resolved, 'No Title')
    expect(map.get('PAGE1')).toBe('No Title')
  })

  it('returns an empty map for an empty input', () => {
    const map = buildTitleMap([], 'Untitled')
    expect(map.size).toBe(0)
  })

  it('later entries overwrite earlier ones for duplicate ids', () => {
    const resolved: ResolvedBlock[] = [
      { id: 'PAGE1', title: 'First', block_type: 'page', deleted: false },
      { id: 'PAGE1', title: 'Second', block_type: 'page', deleted: false },
    ]
    const map = buildTitleMap(resolved, 'Untitled')
    expect(map.size).toBe(1)
    expect(map.get('PAGE1')).toBe('Second')
  })
})

describe('extractUlidRefs (regression guard for helper cohabitation)', () => {
  it('still extracts all three reference forms', () => {
    const content =
      'See [[01ABCDEFGHJKLMNPQRSTUVWXYZ]] and #[01ZYXWVUTSRQPNMLKJHGFEDCBA] and ((01AAAAAAAAAAAAAAAAAAAAAAAA))'
    const refs = extractUlidRefs(content)
    expect(refs).toHaveLength(3)
  })

  it('returns an empty array for plain text', () => {
    expect(extractUlidRefs('plain text content')).toHaveLength(0)
  })
})
