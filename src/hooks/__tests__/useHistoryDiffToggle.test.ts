import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffSpan, HistoryEntry } from '../../lib/tauri'
import { useHistoryDiffToggle } from '../useHistoryDiffToggle'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('../../lib/tauri', () => ({
  computeEditDiff: vi.fn(),
}))

import { computeEditDiff } from '../../lib/tauri'

const mockedComputeEditDiff = vi.mocked(computeEditDiff)
const mockedToastError = vi.mocked(toast.error)

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    device_id: 'dev-1',
    seq: 1,
    op_type: 'edit_block',
    payload: JSON.stringify({ to_text: 'hello' }),
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

const fakeDiff: DiffSpan[] = [{ tag: 'Equal', value: 'hello' }]

describe('useHistoryDiffToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with empty expandedKeys, diffCache, loadingDiffs', () => {
    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))
    expect(result.current.expandedKeys.size).toBe(0)
    expect(result.current.diffCache.size).toBe(0)
    expect(result.current.loadingDiffs.size).toBe(0)
  })

  it('expands an entry and fetches diff', async () => {
    mockedComputeEditDiff.mockResolvedValue(fakeDiff)

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 42 })

    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    expect(result.current.expandedKeys.has(42)).toBe(true)
    expect(result.current.diffCache.get(42)).toEqual(fakeDiff)
    expect(result.current.loadingDiffs.has(42)).toBe(false)
    expect(mockedComputeEditDiff).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      seq: 42,
    })
  })

  it('collapses an already-expanded entry', async () => {
    mockedComputeEditDiff.mockResolvedValue(fakeDiff)

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 10 })

    // Expand
    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })
    expect(result.current.expandedKeys.has(10)).toBe(true)

    // Collapse
    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })
    expect(result.current.expandedKeys.has(10)).toBe(false)
  })

  it('uses cached diff when re-expanding (does not call computeEditDiff again)', async () => {
    mockedComputeEditDiff.mockResolvedValue(fakeDiff)

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 5 })

    // Expand
    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })
    expect(mockedComputeEditDiff).toHaveBeenCalledTimes(1)

    // Collapse
    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    // Re-expand — should use cache
    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })
    expect(mockedComputeEditDiff).toHaveBeenCalledTimes(1)
    expect(result.current.expandedKeys.has(5)).toBe(true)
    expect(result.current.diffCache.get(5)).toEqual(fakeDiff)
  })

  it('shows loading state during fetch', async () => {
    let resolveFetch!: (v: DiffSpan[] | null) => void
    mockedComputeEditDiff.mockImplementation(
      () =>
        new Promise<DiffSpan[] | null>((r) => {
          resolveFetch = r
        }),
    )

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 7 })

    let togglePromise: Promise<void>
    act(() => {
      togglePromise = result.current.handleToggleDiff(entry)
    })

    // While the fetch is in-flight, loadingDiffs should contain the key
    await waitFor(() => {
      expect(result.current.loadingDiffs.has(7)).toBe(true)
    })

    // Resolve the fetch
    await act(async () => {
      resolveFetch(fakeDiff)
      await togglePromise
    })

    expect(result.current.loadingDiffs.has(7)).toBe(false)
  })

  it('on error: removes from expandedKeys and shows toast', async () => {
    mockedComputeEditDiff.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 99 })

    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    // Error recovery: key should be removed from expandedKeys
    expect(result.current.expandedKeys.has(99)).toBe(false)
    expect(result.current.loadingDiffs.has(99)).toBe(false)
    expect(mockedToastError).toHaveBeenCalledWith('Failed to load diff')
  })

  it('works with number keys (HistoryPanel pattern)', async () => {
    mockedComputeEditDiff.mockResolvedValue(fakeDiff)

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 100 })

    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    expect(result.current.expandedKeys.has(100)).toBe(true)
    expect(result.current.diffCache.has(100)).toBe(true)
  })

  it('works with string keys (HistoryView pattern)', async () => {
    mockedComputeEditDiff.mockResolvedValue(fakeDiff)

    const { result } = renderHook(() =>
      useHistoryDiffToggle<string>((entry) => `${entry.device_id}:${entry.seq}`),
    )

    const entry = makeEntry({ device_id: 'dev-abc', seq: 3 })
    const expectedKey = 'dev-abc:3'

    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    expect(result.current.expandedKeys.has(expectedKey)).toBe(true)
    expect(result.current.diffCache.get(expectedKey)).toEqual(fakeDiff)
  })

  it('handles null diff result (does not add to cache)', async () => {
    mockedComputeEditDiff.mockResolvedValue(null)

    const { result } = renderHook(() => useHistoryDiffToggle<number>((entry) => entry.seq))

    const entry = makeEntry({ seq: 20 })

    await act(async () => {
      await result.current.handleToggleDiff(entry)
    })

    expect(result.current.expandedKeys.has(20)).toBe(true)
    expect(result.current.diffCache.has(20)).toBe(false)
    expect(result.current.loadingDiffs.has(20)).toBe(false)
  })
})
