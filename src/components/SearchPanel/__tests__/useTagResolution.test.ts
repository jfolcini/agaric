/**
 * Tests for useTagResolution (#717).
 *
 * Validates the three resolution states the hook now reports:
 *  - `pending` — true while the space's tag listing is in flight, so the
 *    caller can HOLD the search instead of firing it unfiltered.
 *  - resolved — exact (case-insensitive) match contributes its id.
 *  - unresolved — a settled lookup with no exact match sets
 *    `hasUnresolved` (and is cached as settled, so the unknown name is
 *    looked up exactly once — no refetch loop).
 *
 * Also pins: a failed lookup IPC settles as unresolved (conservative —
 * Empty results beat unfiltered ones), the space-switch cache drop still
 * re-resolves, and a tag name change re-resolves unknown names (#5255).
 *
 * NOTE: `tagNames` props are module-level constants — the resolve
 * effect's dep array includes `tagNames`, so an inline literal would
 * re-fire it on every render.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The hook calls `commands.listAllTagsInSpace` from `@/lib/bindings` directly
// (#5237 — the space's own list, not the unscoped prefix lookup) and unwraps
// the `Result` envelope, so the mock intercepts THAT and resolves the
// `{ status: 'ok', data }` shape.
const mockedListTags = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listAllTagsInSpace: (...args: unknown[]) =>
        mockedListTags(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { useTagResolution } from '@/components/SearchPanel/useTagResolution'
import type { TagCacheRow } from '@/lib/bindings'
import { invalidateNameCaches, notifyPageRenamed, notifyTagAdded } from '@/lib/name-change-bus'

const NO_NAMES: string[] = []
const WIP: string[] = ['wip']
const TYPO: string[] = ['typo']
const WIP_AND_TYPO: string[] = ['wip', 'typo']
const WIP_AND_CASE_VARIANTS: string[] = ['wip', 'Foo', 'foo']

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
    mockedListTags.mockResolvedValue([wipTag])

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

  // #5237 — a name is unique per space, so the lookup is the ACTIVE space's own
  // listing: the unscoped prefix lookup answered whichever space's `wip` sorted
  // first, and the space-scoped search then matched nothing. One listing
  // settles every name, case variants (`tag:#Foo tag:#foo`, #2275) included.
  it('resolves every name from one listing of the active space', async () => {
    mockedListTags.mockResolvedValue([wipTag, makeTag({ tag_id: 'TAG_FOO', name: 'foo' })])

    const { result } = renderHook(() => useTagResolution(WIP_AND_CASE_VARIANTS, 'SPACE_A'))

    await waitFor(() => {
      expect(result.current).toEqual({
        tagIds: ['TAG_WIP', 'TAG_FOO', 'TAG_FOO'],
        pending: false,
        hasUnresolved: false,
      })
    })
    expect(mockedListTags).toHaveBeenCalledWith({ kind: 'active', space_id: 'SPACE_A' })
  })

  // #5255 — the tag a `tag:#typo` search names is created later: by a synced
  // peer or an MCP agent (an `invalidated` name change), or by a local surface.
  it.each([
    ['an invalidated name change', () => invalidateNameCaches()],
    ['a local tag creation', () => notifyTagAdded('TAG_TYPO', 'typo', 'SPACE_A')],
  ])('re-resolves a name settled as unknown after %s', async (_label, publish) => {
    mockedListTags.mockResolvedValue([])
    const { result } = renderHook(() => useTagResolution(TYPO, 'SPACE_A'))
    await waitFor(() => {
      expect(result.current.hasUnresolved).toBe(true)
    })
    mockedListTags.mockResolvedValue([makeTag({ tag_id: 'TAG_TYPO', name: 'typo' })])

    act(() => {
      publish()
    })

    await waitFor(() => {
      expect(result.current).toEqual({ tagIds: ['TAG_TYPO'], pending: false, hasUnresolved: false })
    })
  })

  it('keeps an unknown name settled across a page rename', async () => {
    mockedListTags.mockResolvedValue([])
    const { result } = renderHook(() => useTagResolution(TYPO, 'SPACE_A'))
    await waitFor(() => {
      expect(result.current.hasUnresolved).toBe(true)
    })
    const settledCallCount = mockedListTags.mock.calls.length

    act(() => {
      notifyPageRenamed('PAGE_1', 'typo', 'SPACE_A')
    })

    expect(result.current.pending).toBe(false)
    expect(mockedListTags).toHaveBeenCalledTimes(settledCallCount)
  })

  it('keeps a resolved id across an invalidated name change, holding no search', async () => {
    mockedListTags.mockResolvedValue([wipTag])
    const { result } = renderHook(() => useTagResolution(WIP, 'SPACE_A'))
    await waitFor(() => {
      expect(result.current.tagIds).toEqual(['TAG_WIP'])
    })
    const settledCallCount = mockedListTags.mock.calls.length

    act(() => {
      invalidateNameCaches()
    })

    expect(result.current).toEqual({ tagIds: ['TAG_WIP'], pending: false, hasUnresolved: false })
    expect(mockedListTags).toHaveBeenCalledTimes(settledCallCount)
  })
})
