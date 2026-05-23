/**
 * Tests for useAutocompleteSources (PEND-60 Phase 2).
 *
 * Validates:
 *  - Null anchor returns empty.
 *  - Static projections (state / priority / date) filter by prefix.
 *  - Path anchor projects path-history via the mocked module.
 *  - Tag anchor debounces, maps results, keeps stale items in-flight,
 *    and discards stale resolutions.
 *  - PropKey IPC is cached at module scope across re-renders.
 *  - IPC rejections are logged via `logger.warn` and don't throw.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TagCacheRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { getPathHistory } from '@/lib/path-history'
import type { AutocompleteAnchor } from '@/lib/search-query/autocomplete'
import { listPropertyKeys, listTagsByPrefix } from '@/lib/tauri'

vi.mock('@/lib/tauri', () => ({
  listTagsByPrefix: vi.fn(),
  listPropertyKeys: vi.fn(),
  paginationLimit: (n: number) => n,
}))

vi.mock('@/lib/path-history', () => ({
  getPathHistory: vi.fn(() => [] as string[]),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { _resetPropertyKeysCacheForTest } from '@/hooks/usePropertyKeysCache'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '@/lib/priority-levels'
import { useAutocompleteSources } from '../useAutocompleteSources'

const mockedListTagsByPrefix = vi.mocked(listTagsByPrefix)
const mockedListPropertyKeys = vi.mocked(listPropertyKeys)
const mockedGetPathHistory = vi.mocked(getPathHistory)

function tag(name: string, id = `T-${name}`): TagCacheRow {
  return { tag_id: id, name, usage_count: 1, updated_at: '2024-01-01T00:00:00Z' }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  _resetPropertyKeysCacheForTest()
  __resetPriorityLevelsForTests()
  mockedGetPathHistory.mockReturnValue([])
  mockedListTagsByPrefix.mockResolvedValue([])
  mockedListPropertyKeys.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAutocompleteSources', () => {
  it('null anchor returns empty items and not loading', () => {
    const { result } = renderHook(() => useAutocompleteSources({ anchor: null, spaceId: 'S1' }))
    expect(result.current).toEqual({ items: [], loading: false })
  })

  it('state anchor filters STATE_VALUES by prefix', () => {
    const anchor: AutocompleteAnchor = { active: 'state', query: 'T', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items).toEqual([{ value: 'TODO' }])
    expect(result.current.loading).toBe(false)
  })

  it('priority anchor projects the default numeric levels + none', () => {
    // DOC-A7 follow-up — autocomplete must offer the real numeric priority
    // values (`DEFAULT_PRIORITY_LEVELS`), not the stale hardcoded `A/B/C`
    // that never matched the filter parser.
    const anchor: AutocompleteAnchor = { active: 'priority', query: '', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items.map((i) => i.value)).toEqual(['1', '2', '3', 'none'])
    expect(result.current.loading).toBe(false)
  })

  it('priority anchor reflects user-configured priority levels', () => {
    // The values are driven by the configurable source of truth, so a
    // custom level set flows straight through to the popover.
    act(() => {
      setPriorityLevels(['P0', 'P1'])
    })
    const anchor: AutocompleteAnchor = { active: 'priority', query: '', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items.map((i) => i.value)).toEqual(['P0', 'P1', 'none'])
  })

  it('due anchor with query "to" returns only "today"', () => {
    const anchor: AutocompleteAnchor = { active: 'due', query: 'to', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items).toEqual([{ value: 'today' }])
  })

  it('pathInclude anchor projects path-history filtered by prefix', () => {
    mockedGetPathHistory.mockReturnValue(['Journal/*', 'Archive/2024'])
    const anchor: AutocompleteAnchor = { active: 'pathInclude', query: 'j', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items).toEqual([{ value: 'Journal/*' }])
    expect(result.current.loading).toBe(false)
    expect(mockedGetPathHistory).toHaveBeenCalledWith('S1')
  })

  it('pathExclude anchor shares the same path-history projection', () => {
    mockedGetPathHistory.mockReturnValue(['Journal/*', 'Archive/2024'])
    const anchor: AutocompleteAnchor = { active: 'pathExclude', query: 'a', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current.items).toEqual([{ value: 'Archive/2024' }])
    expect(result.current.loading).toBe(false)
  })

  it('tag anchor: debounces IPC by 150ms and maps rows to items', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([tag('project-x'), tag('project-y')])
    const anchor: AutocompleteAnchor = { active: 'tag', query: 'pro', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))

    // Before debounce flushes: IPC not yet called, loading true.
    expect(mockedListTagsByPrefix).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    expect(mockedListTagsByPrefix).toHaveBeenCalledWith({ prefix: 'pro', limit: 20 })
    expect(result.current.items).toEqual([{ value: 'project-x' }, { value: 'project-y' }])
    expect(result.current.loading).toBe(false)
  })

  it('tag anchor: keeps previous items visible while a new request is in flight', async () => {
    mockedListTagsByPrefix.mockResolvedValueOnce([tag('alpha'), tag('apple')])
    const anchor1: AutocompleteAnchor = { active: 'tag', query: 'a', anchor: 0 }
    const { result, rerender } = renderHook(
      ({ a }: { a: AutocompleteAnchor }) => useAutocompleteSources({ anchor: a, spaceId: 'S1' }),
      { initialProps: { a: anchor1 } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.items.map((i) => i.value)).toEqual(['alpha', 'apple'])

    // Second query — schedule a slower resolution so we can inspect the
    // in-flight state with the previous items still visible.
    let resolveSecond: (rows: TagCacheRow[]) => void = () => {}
    mockedListTagsByPrefix.mockReturnValueOnce(
      new Promise<TagCacheRow[]>((res) => {
        resolveSecond = res
      }),
    )

    rerender({ a: { active: 'tag', query: 'ab', anchor: 0 } })
    // Flush the debounce so the IPC actually fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // Items remain stale (the first batch) while the second flies.
    expect(result.current.items.map((i) => i.value)).toEqual(['alpha', 'apple'])
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveSecond([tag('ab-tag')])
      await Promise.resolve()
    })
    expect(result.current.items).toEqual([{ value: 'ab-tag' }])
    expect(result.current.loading).toBe(false)
  })

  it('tag anchor: stale response does NOT clobber a newer batch', async () => {
    let resolveSlow: (rows: TagCacheRow[]) => void = () => {}
    mockedListTagsByPrefix.mockReturnValueOnce(
      new Promise<TagCacheRow[]>((res) => {
        resolveSlow = res
      }),
    )
    const anchor1: AutocompleteAnchor = { active: 'tag', query: 'a', anchor: 0 }
    const { result, rerender } = renderHook(
      ({ a }: { a: AutocompleteAnchor }) => useAutocompleteSources({ anchor: a, spaceId: 'S1' }),
      { initialProps: { a: anchor1 } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    // Slow request now in-flight; second query supersedes it.
    mockedListTagsByPrefix.mockResolvedValueOnce([tag('beta')])
    rerender({ a: { active: 'tag', query: 'b', anchor: 0 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.items).toEqual([{ value: 'beta' }])

    // Stale slow response arrives last — should be discarded.
    await act(async () => {
      resolveSlow([tag('stale')])
      await Promise.resolve()
    })
    expect(result.current.items).toEqual([{ value: 'beta' }])
  })

  it('propKey anchor: IPC called once across re-renders within the same session', async () => {
    mockedListPropertyKeys.mockResolvedValue(['status', 'owner', 'estimate'])
    const { rerender, result } = renderHook(
      ({ a }: { a: AutocompleteAnchor }) => useAutocompleteSources({ anchor: a, spaceId: 'S1' }),
      { initialProps: { a: { active: 'propKey', query: '', anchor: 0 } as AutocompleteAnchor } },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockedListPropertyKeys).toHaveBeenCalledTimes(1)
    expect(result.current.items.map((i) => i.value)).toEqual(['status', 'owner', 'estimate'])

    rerender({ a: { active: 'propKey', query: 'o', anchor: 0 } })
    expect(mockedListPropertyKeys).toHaveBeenCalledTimes(1)
    expect(result.current.items).toEqual([{ value: 'owner' }])

    rerender({ a: { active: 'propKey', query: 'es', anchor: 0 } })
    expect(mockedListPropertyKeys).toHaveBeenCalledTimes(1)
    expect(result.current.items).toEqual([{ value: 'estimate' }])
  })

  it('tag IPC rejection logs via logger.warn and does not throw', async () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    mockedListTagsByPrefix.mockRejectedValueOnce(new Error('ipc-boom'))
    const anchor: AutocompleteAnchor = { active: 'tag', query: 'x', anchor: 0 }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    expect(warnSpy).toHaveBeenCalled()
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('propValue anchor returns empty (deferred past Phase 2)', () => {
    const anchor: AutocompleteAnchor = {
      active: 'propValue',
      key: 'status',
      query: '',
      anchor: 0,
    }
    const { result } = renderHook(() => useAutocompleteSources({ anchor, spaceId: 'S1' }))
    expect(result.current).toEqual({ items: [], loading: false })
  })
})
