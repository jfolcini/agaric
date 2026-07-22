/**
 * Tests for `usePageAliases` — page-alias CRUD hook extracted from
 * `PageHeader` during the design-system maintainability pass.
 *
 * Covers:
 *  1. Initial fetch on mount populates `aliases`.
 *  2. Non-array backend payloads (`null`) coerce to `[]`.
 *  3. Fetch error notifies and leaves `aliases` empty.
 *  4. `handleAddAlias` trims, appends, persists, and clears the input.
 *  5. `handleAddAlias` is a no-op when the draft is whitespace only.
 *  6. `handleRemoveAlias` filters the list and persists the new array.
 *  7. `startEditing` / `stopEditing` flip `editingAliases`.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri', () => ({
  getPageAliases: vi.fn(),
  setPageAliases: vi.fn(),
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { usePageAliases } from '@/hooks/usePageAliases'
import { announce } from '@/lib/announcer'
import { getPageAliases, setPageAliases } from '@/lib/tauri'

const mockedGet = vi.mocked(getPageAliases)
const mockedSet = vi.mocked(setPageAliases)
const mockedAnnounce = vi.mocked(announce)
const t = (key: string) => key

beforeEach(() => {
  vi.clearAllMocks()
  mockedGet.mockResolvedValue([])
  // `setPageAliases` returns the persisted aliases; the hook ignores
  // the return value, but the type system enforces a `string[]` here.
  mockedSet.mockResolvedValue([])
})

describe('usePageAliases — initial fetch', () => {
  it('populates `aliases` from `getPageAliases`', async () => {
    mockedGet.mockResolvedValueOnce(['alpha', 'beta'])
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta'])
    })
    expect(mockedGet).toHaveBeenCalledWith('page-1')
  })

  it('coerces a non-array payload to an empty array', async () => {
    // Older SQLite migrations returned `null` for unset aliases.
    mockedGet.mockResolvedValueOnce(null as unknown as string[])
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })
    expect(result.current.aliases).toEqual([])
  })

  it('skips the fetch entirely when `pageId` is empty', () => {
    renderHook(() => usePageAliases('', t))
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('handles fetch failure without throwing', async () => {
    mockedGet.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })
    expect(result.current.aliases).toEqual([])
  })
})

describe('usePageAliases — add / remove', () => {
  it('handleAddAlias trims, appends, persists, and clears the input only after the write resolves', async () => {
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    act(() => {
      result.current.setAliasInput('  Nickname  ')
    })

    act(() => {
      result.current.handleAddAlias()
    })

    // Optimistic list update happens synchronously, but the input draft
    // is NOT cleared until `setPageAliases` resolves.
    expect(result.current.aliases).toEqual(['Nickname'])
    expect(mockedSet).toHaveBeenCalledWith('page-1', ['Nickname'])
    expect(result.current.aliasInput).toBe('  Nickname  ')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasAdded')

    await waitFor(() => {
      expect(result.current.aliasInput).toBe('')
    })
  })

  it('handleAddAlias rolls back the optimistic list and keeps the draft when the write fails', async () => {
    mockedSet.mockRejectedValueOnce(new Error('ipc failure'))
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    act(() => {
      result.current.setAliasInput('Nickname')
    })
    act(() => {
      result.current.handleAddAlias()
    })

    // Optimistic update applied immediately.
    expect(result.current.aliases).toEqual(['Nickname'])

    await waitFor(() => {
      expect(result.current.aliases).toEqual([])
    })
    // The draft is preserved (never optimistically cleared) so the user
    // can retry without retyping.
    expect(result.current.aliasInput).toBe('Nickname')
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasFailed')
  })

  it('handleAddAlias is a no-op for whitespace-only drafts', async () => {
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })

    act(() => {
      result.current.setAliasInput('   ')
    })
    act(() => {
      result.current.handleAddAlias()
    })

    expect(mockedSet).not.toHaveBeenCalled()
    expect(result.current.aliases).toEqual([])
  })

  it('handleRemoveAlias filters out the alias and persists', async () => {
    mockedGet.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta', 'gamma'])
    })

    act(() => {
      result.current.handleRemoveAlias('beta')
    })

    expect(result.current.aliases).toEqual(['alpha', 'gamma'])
    expect(mockedSet).toHaveBeenCalledWith('page-1', ['alpha', 'gamma'])
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasRemoved')
  })

  it('handleRemoveAlias rolls back the optimistic list when the write fails', async () => {
    mockedGet.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    mockedSet.mockRejectedValueOnce(new Error('ipc failure'))
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta', 'gamma'])
    })

    act(() => {
      result.current.handleRemoveAlias('beta')
    })

    // Optimistic removal applied immediately.
    expect(result.current.aliases).toEqual(['alpha', 'gamma'])

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta', 'gamma'])
    })
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasFailed')
  })

  it('does not let a stale rollback clobber a later, already-successful mutation', async () => {
    // Two removals fire before either resolves: remove 'beta', then
    // (from the resulting optimistic state) remove 'gamma'. The SECOND
    // call's write resolves first; the FIRST call's write then rejects.
    // The first call's rollback must not revive 'beta' or discard the
    // second call's successful removal of 'gamma'.
    mockedGet.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const { result } = renderHook(() => usePageAliases('page-1', t))

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta', 'gamma'])
    })

    let rejectFirst!: (err: unknown) => void
    let resolveSecond!: (value: string[]) => void
    mockedSet
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )

    act(() => {
      result.current.handleRemoveAlias('beta')
    })
    expect(result.current.aliases).toEqual(['alpha', 'gamma'])

    act(() => {
      result.current.handleRemoveAlias('gamma')
    })
    expect(result.current.aliases).toEqual(['alpha'])

    // Later call's write settles first.
    await act(async () => {
      resolveSecond(['alpha'])
    })
    expect(result.current.aliases).toEqual(['alpha'])

    // Earlier call's write rejects afterward — its rollback target
    // (['alpha', 'beta', 'gamma']) is stale and must be discarded.
    await act(async () => {
      rejectFirst(new Error('ipc failure'))
    })
    expect(result.current.aliases).toEqual(['alpha'])
  })
})

describe('usePageAliases — editing flag', () => {
  it('startEditing / stopEditing flip the flag', () => {
    const { result } = renderHook(() => usePageAliases('page-1', t))
    expect(result.current.editingAliases).toBe(false)

    act(() => {
      result.current.startEditing()
    })
    expect(result.current.editingAliases).toBe(true)

    act(() => {
      result.current.stopEditing()
    })
    expect(result.current.editingAliases).toBe(false)
  })
})
