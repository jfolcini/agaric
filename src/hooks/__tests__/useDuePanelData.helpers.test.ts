/**
 * Unit tests for the pure helpers extracted from useDuePanelData.
 *
 * The helpers are small, side-effect-free, and deterministic — no Tauri
 * mocking, no React renderer. Each covers the happy path plus the
 * branches that the hook exercises.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { collectResolveIds, extractUlidRefs } from '@/hooks/useDuePanelData'

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

  it('extracts the id of a table cell link, whose label pipe is escaped', () => {
    expect(extractUlidRefs('| [[01ABCDEFGHJKLMNPQRSTUVWXYZ\\|label]] | x |')).toEqual([
      '01ABCDEFGHJKLMNPQRSTUVWXYZ',
    ])
  })
})
