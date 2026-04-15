/**
 * Tests for useBacklinkResolution hook.
 *
 * Validates:
 *  - Cache hit (returns cached value without invoking)
 *  - Cache miss (invokes backend, caches result)
 *  - TTL expiration (stale cache triggers re-fetch)
 *  - clearCache empties the cache
 *  - Fallback titles for unresolved IDs
 *  - Tag resolution uses tag fallback format
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  batchResolve: vi.fn(),
}))

import type { BacklinkGroup } from '../../lib/tauri'
import { batchResolve } from '../../lib/tauri'
import { useBacklinkResolution } from '../useBacklinkResolution'

const mockedBatchResolve = vi.mocked(batchResolve)

// 26-char uppercase ULIDs for matching the [0-9A-Z]{26} regex
const ULID_A = '01HAAAAA0000000000000000AA'
const ULID_B = '01HBBBBB0000000000000000BB'
const ULID_TAG = '01HTTTTT0000000000000000TT'

function makeGroup(blocks: Array<{ id: string; content: string | null }>): BacklinkGroup {
  return {
    page_id: 'P1',
    page_title: 'Source',
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: 'content',
      content: b.content,
      parent_id: 'P1',
      position: 1,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useBacklinkResolution', () => {
  it('returns fallback titles when groups have no ULID tokens', () => {
    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: 'plain text' }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    expect(result.current.resolveBlockTitle('UNKNOWN_ID')).toBe('[[UNKNOWN_...]]')
    expect(result.current.resolveTagName('UNKNOWN_ID')).toBe('#UNKNOWN_...')
    expect(result.current.resolveBlockStatus('UNKNOWN_ID')).toBe('active')
  })

  it('resolves ULID tokens via batchResolve on cache miss', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'My Page', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `Link to [[${ULID_A}]] here` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    // Wait for batchResolve to be called and resolved
    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A])
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('My Page')
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('active')
  })

  it('returns cached value without invoking on cache hit', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Cached Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    // Wait for first resolution
    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
    })

    // Clear mock to verify it's not called again
    mockedBatchResolve.mockClear()

    // Re-render with same groups (same ULID) — should use cache
    rerender({ g: [...groups] })

    // batchResolve should not be called again (cache hit)
    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })

    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
  })

  it('re-fetches when TTL expires', async () => {
    vi.useFakeTimers()

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Fresh Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    // Wait for first resolution
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Fresh Title')

    // Advance time past TTL (5 minutes + 1ms)
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    })

    mockedBatchResolve.mockClear()
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Updated Title', block_type: 'page', deleted: false },
    ])

    // Re-render with a new groups reference to trigger the effect
    rerender({ g: [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])] })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    // Should have called batchResolve again due to TTL expiration
    expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Updated Title')
  })

  it('resolves tag tokens with #[] syntax', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_TAG, title: 'important', block_type: 'tag', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `Tagged #[${ULID_TAG}] content` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveTagName(ULID_TAG)).toBe('important')
    })
  })

  it('marks deleted blocks correctly', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Deleted Page', block_type: 'page', deleted: true },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockStatus(ULID_A)).toBe('deleted')
    })
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Deleted Page')
  })

  it('provides fallback for IDs not returned by batchResolve', async () => {
    // batchResolve returns empty — ULID_A not found
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    await waitFor(() => {
      // Fallback title uses first 8 chars
      expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('deleted')
  })

  it('clearCache empties the cache', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Will Be Cleared', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Will Be Cleared')
    })

    act(() => {
      result.current.clearCache()
    })

    // After clearing, resolveBlockTitle returns fallback
    expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
  })

  it('handles batchResolve errors gracefully', async () => {
    mockedBatchResolve.mockRejectedValue(new Error('network error'))

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    // Should not throw — returns fallback
    expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
  })

  it('resolves multiple ULIDs in a single batch', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Page A', block_type: 'page', deleted: false },
      { id: ULID_B, title: 'Page B', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [
      makeGroup([{ id: 'B1', content: `[[${ULID_A}]] and [[${ULID_B}]]` }]),
    ]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith(expect.arrayContaining([ULID_A, ULID_B]))
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Page A')
    })
    expect(result.current.resolveBlockTitle(ULID_B)).toBe('Page B')
  })

  it('skips blocks with null content', async () => {
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: null }])]

    renderHook(() => useBacklinkResolution(groups))

    // batchResolve should not be called since there are no ULIDs to resolve
    // (the effect returns early when allBlocks have no content)
    // Wait a tick to ensure the effect ran
    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
  })

  it('uses tag fallback format for tags without titles', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_TAG, title: null, block_type: 'tag', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `#[${ULID_TAG}]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveTagName(ULID_TAG)).toBe(`#${ULID_TAG.slice(0, 8)}...`)
    })
  })
})
