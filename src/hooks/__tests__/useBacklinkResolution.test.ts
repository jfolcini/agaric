/**
 * Tests for useBacklinkResolution hook (#2635 — delegated to useResolveStore).
 *
 * Validates:
 *  - Real titles/statuses come from the shared `useResolveStore` (one cache).
 *  - Cache hit: an id already in the store is not re-resolved.
 *  - Unresolved ids (backend didn't return them) render as broken links
 *    (deleted status) WITHOUT polluting the shared store.
 *  - `clearCache()` does NOT wipe the shared store; it re-attempts resolution
 *    so a renamed target picks up its fresh title (#2628).
 *  - Tag fallback format; space-scoped resolution (#2543); error handling.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  batchResolve: vi.fn(),
}))

import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import type { BacklinkGroup } from '@/lib/tauri'
import { batchResolve } from '@/lib/tauri'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

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
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })),
  }
}

const initialSpaceState = useSpaceStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  // Fresh shared store per test — the hook now delegates all real resolution
  // to `useResolveStore`, so isolate its cache between cases.
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  // Default: no active space — `keyFor(null, id)` resolves to the
  // `__global__::id` slot so existing tests behave as before.
  useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: null })
})

afterEach(() => {
  vi.useRealTimers()
  useSpaceStore.setState({ ...initialSpaceState })
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

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], 'global')
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('My Page')
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('active')
  })

  it('writes real resolutions into the shared useResolveStore (single cache)', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Shared Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    // The resolution is visible to ANY other consumer of the shared store,
    // not just via the hook — proving there is one cache, not two.
    await waitFor(() => {
      expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Shared Title')
    })
    expect(useResolveStore.getState().has(ULID_A)).toBe(true)
  })

  it('reads a title already present in the shared store without invoking batchResolve', async () => {
    // Pre-seed the shared store, as if another consumer already resolved it.
    useResolveStore.getState().set(ULID_A, 'Preseeded Title', false)

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Preseeded Title')
    // Already in the store → no IPC.
    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
  })

  it('returns cached value without invoking on cache hit', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Cached Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
    })

    mockedBatchResolve.mockClear()

    // Re-render with same ULID — now in the store, so no re-resolve.
    rerender({ g: [...groups] })

    await waitFor(() => {
      expect(mockedBatchResolve).not.toHaveBeenCalled()
    })
    expect(result.current.resolveBlockTitle(ULID_A)).toBe('Cached Title')
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

  it('renders a broken link for IDs not returned by batchResolve WITHOUT polluting the store', async () => {
    // batchResolve returns empty — ULID_A not found (foreign-space / deleted).
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    await waitFor(() => {
      // Broken-link fallback title + deleted status (backlink-local).
      expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
    })
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('deleted')

    // The unresolved id must NOT have leaked into the app-wide store — that
    // would corrupt the cache for every other consumer (#2635).
    expect(useResolveStore.getState().has(ULID_A)).toBe(false)
    expect(useResolveStore.getState().cache.size).toBe(0)
  })

  it('clearCache re-attempts resolution so a renamed target picks up its fresh title (#2628)', async () => {
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Old Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result, rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Old Title')
    })

    // Target was renamed on the backend.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'New Title', block_type: 'page', deleted: false },
    ])

    // clearCache does NOT wipe the shared store (still holds "Old Title")...
    act(() => {
      result.current.clearCache()
    })
    expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('Old Title')

    // ...but it latches a forced re-resolve: the next groups change re-fetches
    // even though the id is already cached, refreshing the store to "New Title".
    rerender({ g: [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])] })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('New Title')
    })
    expect(useResolveStore.getState().resolveTitle(ULID_A)).toBe('New Title')
  })

  it('clearCache does not clear the shared store for other consumers', async () => {
    // A sibling consumer's entry lives in the shared store.
    useResolveStore.getState().set(ULID_B, 'Sibling Page', false)

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: 'plain text' }])]
    const { result } = renderHook(() => useBacklinkResolution(groups))

    act(() => {
      result.current.clearCache()
    })

    // The sibling's cached title survives clearCache().
    expect(useResolveStore.getState().resolveTitle(ULID_B)).toBe('Sibling Page')
  })

  it('handles batchResolve errors gracefully', async () => {
    mockedBatchResolve.mockRejectedValue(new Error('network error'))

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalled()
    })

    // Should not throw — returns fallback, active (not marked deleted on error).
    expect(result.current.resolveBlockTitle(ULID_A)).toBe(`[[${ULID_A.slice(0, 8)}...]]`)
    expect(result.current.resolveBlockStatus(ULID_A)).toBe('active')
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
      expect(mockedBatchResolve).toHaveBeenCalledWith(
        expect.arrayContaining([ULID_A, ULID_B]),
        'global',
      )
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

    // batchResolve should not be called since there are no ULIDs to resolve.
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

  it('returns different titles for the same ULID in two spaces (space-scoped store)', async () => {
    // Same backlink id resolves to different titles in two different spaces.
    // The shared store is composite-keyed by space, so switching spaces is a
    // cache miss that re-resolves, and switching back is a hit.
    useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: 'SPACE_AAAA' })

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in A', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    const { result } = renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in A')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(1)

    // Switch space — cache miss under `keyFor('SPACE_BBBB', ULID_A)`.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in B', block_type: 'page', deleted: false },
    ])
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_BBBB' })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in B')
    })
    expect(mockedBatchResolve).toHaveBeenCalledTimes(2)

    // Switch back to space A — still cached, no third IPC.
    mockedBatchResolve.mockClear()
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_AAAA' })
    })

    await waitFor(() => {
      expect(result.current.resolveBlockTitle(ULID_A)).toBe('Title in A')
    })
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  // #2543 — scope resolution to the active space, not the literal 'global'.
  it('scopes batchResolve to the active space instead of the literal global (#2543)', async () => {
    useSpaceStore.setState({ ...initialSpaceState, currentSpaceId: 'SPACE_AAAA' })

    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Title in A', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], 'SPACE_AAAA')
    })
    expect(mockedBatchResolve).not.toHaveBeenCalledWith([ULID_A], 'global')
  })

  it('falls back to global scope when there is no active space', async () => {
    // Default beforeEach state: currentSpaceId is null.
    mockedBatchResolve.mockResolvedValue([
      { id: ULID_A, title: 'Some Title', block_type: 'page', deleted: false },
    ])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]

    renderHook(() => useBacklinkResolution(groups))

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledWith([ULID_A], 'global')
    })
  })

  it('does not re-fetch an id that was already attempted-but-unresolved', async () => {
    mockedBatchResolve.mockResolvedValue([])

    const groups: BacklinkGroup[] = [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])]
    const { rerender } = renderHook(({ g }) => useBacklinkResolution(g), {
      initialProps: { g: groups },
    })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })

    // Re-render with a new groups reference containing the same unresolved id —
    // the attempted-unresolved set suppresses a redundant IPC.
    rerender({ g: [makeGroup([{ id: 'B1', content: `[[${ULID_A}]]` }])] })

    await waitFor(() => {
      expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    })
  })
})

// Reference `keyFor` so the import is exercised by a lightweight sanity check
// (the hook keys its attempted-unresolved set with the same helper).
describe('useBacklinkResolution — key encoding', () => {
  it('uses the shared composite key encoding', () => {
    expect(keyFor(null, ULID_A)).toBe(`__global__::${ULID_A}`)
    expect(keyFor('SPACE_AAAA', ULID_A)).toBe(`SPACE_AAAA::${ULID_A}`)
  })
})
