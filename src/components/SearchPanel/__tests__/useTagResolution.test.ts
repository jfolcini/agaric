/**
 * Tests for useTagResolution (#717).
 *
 * Validates the three resolution states the hook now reports:
 *  - `pending` — true while a name's prefix lookup is in flight, so the
 *    caller can HOLD the search instead of firing it unfiltered.
 *  - resolved — exact (case-insensitive) match contributes its id.
 *  - unresolved — a settled lookup with no exact match sets
 *    `hasUnresolved` (and is cached as settled, so the unknown name is
 *    looked up exactly once — no refetch loop).
 *
 * Also pins: a failed lookup IPC settles as unresolved (conservative —
 * Empty results beat unfiltered ones), and the space-switch cache
 * drop still re-resolves.
 *
 * NOTE: `tagNames` props are module-level constants — the resolve
 * effect's dep array includes `tagNames`, so an inline literal would
 * re-fire it on every render.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return {
    ...actual,
    listTagsByPrefix: vi.fn(),
  }
})

vi.mock('../../../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { listTagsByPrefix, type TagCacheRow } from '../../../lib/tauri'
import { useTagResolution } from '../useTagResolution'

const mockedListTags = vi.mocked(listTagsByPrefix)

const NO_NAMES: string[] = []
const WIP: string[] = ['wip']
const TYPO: string[] = ['typo']
const WIP_AND_TYPO: string[] = ['wip', 'typo']

function makeTag(overrides: Partial<TagCacheRow> = {}): TagCacheRow {
  return {
    tag_id: 'TAG_WIP',
    name: 'wip',
    usage_count: 1,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const wipTag = makeTag()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTagResolution', () => {
  it('reports no pending work and no ids for an empty name list', () => {
    const { result } = renderHook(() => useTagResolution(NO_NAMES, 'SPACE_A'))
    expect(result.current).toEqual({ tagIds: [], pending: false, hasUnresolved: false })
    expect(mockedListTags).not.toHaveBeenCalled()
  })

  it('is pending while the lookup is in flight, then resolves to the id', async () => {
    let resolveLookup!: (tags: TagCacheRow[]) => void
    mockedListTags.mockReturnValue(
      new Promise<TagCacheRow[]>((resolve) => {
        resolveLookup = resolve
      }),
    )

    const { result } = renderHook(() => useTagResolution(WIP, 'SPACE_A'))

    // #717 — in-flight resolution MUST be reported as pending so the
    // caller holds the search (no transient unfiltered flash).
    expect(result.current.pending).toBe(true)
    expect(result.current.tagIds).toEqual([])
    expect(result.current.hasUnresolved).toBe(false)

    await act(async () => {
      resolveLookup([wipTag])
    })
    await waitFor(() => {
      expect(result.current).toEqual({ tagIds: ['TAG_WIP'], pending: false, hasUnresolved: false })
    })
  })

  it('settles an unknown name as unresolved — NOT as "no tag filter" (#717)', async () => {
    mockedListTags.mockResolvedValue([])

    const { result } = renderHook(() => useTagResolution(TYPO, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
    expect(result.current.tagIds).toEqual([])
    expect(result.current.hasUnresolved).toBe(true)
  })

  it('looks an unknown name up exactly once — no refetch loop', async () => {
    mockedListTags.mockResolvedValue([])

    const { result, rerender } = renderHook(() => useTagResolution(TYPO, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
    // StrictMode double-invokes the mount effect, so assert relatively:
    // once settled, further renders add ZERO lookups (the old code kept
    // re-firing forever for an unknown name because nothing was cached).
    const settledCallCount = mockedListTags.mock.calls.length
    rerender()
    rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockedListTags).toHaveBeenCalledTimes(settledCallCount)
  })

  it('reports a partial outcome: resolved ids AND hasUnresolved together', async () => {
    mockedListTags.mockImplementation(async ({ prefix }) => (prefix === 'wip' ? [wipTag] : []))

    const { result } = renderHook(() => useTagResolution(WIP_AND_TYPO, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
    expect(result.current.tagIds).toEqual(['TAG_WIP'])
    expect(result.current.hasUnresolved).toBe(true)
  })

  it('matches case-insensitively on the exact name', async () => {
    mockedListTags.mockResolvedValue([makeTag({ name: 'WIP' })])

    const { result } = renderHook(() => useTagResolution(WIP, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.tagIds).toEqual(['TAG_WIP'])
    })
    expect(result.current.hasUnresolved).toBe(false)
  })

  it('settles a failed lookup as unresolved (conservative: empty beats unfiltered)', async () => {
    mockedListTags.mockRejectedValue(new Error('transport failed'))

    const { result } = renderHook(() => useTagResolution(WIP, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
    expect(result.current.tagIds).toEqual([])
    expect(result.current.hasUnresolved).toBe(true)
  })

  it('drops the cache and re-resolves on a space switch', async () => {
    mockedListTags.mockResolvedValue([wipTag])

    const { result, rerender } = renderHook(
      ({ spaceId }: { spaceId: string }) => useTagResolution(WIP, spaceId),
      { initialProps: { spaceId: 'SPACE_A' } },
    )

    await waitFor(() => {
      expect(result.current.tagIds).toEqual(['TAG_WIP'])
    })
    // StrictMode double-invokes effects → assert relatively.
    const settledCallCount = mockedListTags.mock.calls.length

    rerender({ spaceId: 'SPACE_B' })

    // The cache is dropped, so the same name resolves again in the new space.
    await waitFor(() => {
      expect(mockedListTags.mock.calls.length).toBeGreaterThan(settledCallCount)
    })
    await waitFor(() => {
      expect(result.current).toEqual({ tagIds: ['TAG_WIP'], pending: false, hasUnresolved: false })
    })
  })
})
