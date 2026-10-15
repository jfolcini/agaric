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
 *  8. A committed write lands on the page's undo stack, and an `invalidated`
 *     name change reloads the list (#5387).
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2927 phase 7 — `usePageAliases` calls `commands.getPageAliases` /
// `commands.setPageAliases` from `@/lib/bindings` directly. The spies keep
// resolving/rejecting with the bare payload; the shim wraps a fulfilment in
// the `{ status: 'ok', data }` envelope `unwrap` expects.
const mockedGet = vi.hoisted(() => vi.fn())
const mockedSet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getPageAliases: (...args: unknown[]) =>
        mockedGet(...args).then((data: unknown) => ({ status: 'ok', data })),
      setPageAliases: (...args: unknown[]) =>
        mockedSet(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

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

import { toast } from 'sonner'

import { usePageAliases } from '@/hooks/usePageAliases'
import { announce } from '@/lib/announcer'
import { getGraphStructureKey } from '@/lib/graph-structure-events'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { useUndoStore } from '@/stores/undo'

const mockedAnnounce = vi.mocked(announce)
const t = (key: string) => key

const OP_REF = { device_id: 'dev-1', seq: 7 }

beforeEach(() => {
  vi.clearAllMocks()
  useUndoStore.setState({ pages: new Map() })
  mockedGet.mockResolvedValue([])
  // `setPageAliases` answers the aliases it stored and the op it appended.
  mockedSet.mockImplementation(async (_pageId: string, aliases: string[]) => ({
    aliases,
    op_refs: [OP_REF],
  }))
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

    await waitFor(() => {
      expect(result.current.aliasInput).toBe('')
    })
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasAdded')
  })

  it('says an alias another page holds is taken instead of announcing it (#5280)', async () => {
    mockedGet.mockResolvedValueOnce(['own'])
    // The backend refuses the whole edit with the alias's code (#5387).
    mockedSet.mockRejectedValueOnce({
      kind: 'validation',
      code: 'DuplicatePageAlias',
      message: "alias 'standup' is already used by another page",
    })
    const { result } = renderHook(() => usePageAliases('page-1', t))
    await waitFor(() => {
      expect(result.current.aliases).toEqual(['own'])
    })

    act(() => {
      result.current.setAliasInput('standup')
    })
    act(() => {
      result.current.handleAddAlias()
    })

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['own'])
    })
    expect(vi.mocked(toast.error).mock.calls.map((c) => c[0])).toEqual(['pageHeader.aliasTaken'])
    expect(mockedAnnounce).toHaveBeenCalledWith('pageHeader.aliasTaken')
    expect(mockedAnnounce).not.toHaveBeenCalledWith('announce.aliasAdded')
    expect(mockedAnnounce).not.toHaveBeenCalledWith('announce.aliasFailed')
    expect(result.current.aliasInput).toBe('standup')
  })

  it("does not call a case variant of the page's own alias taken (#5280)", async () => {
    mockedGet.mockResolvedValueOnce(['Standup'])
    // The write keeps the page's own spelling and drops the variant: no op.
    mockedSet.mockResolvedValueOnce({ aliases: ['Standup'], op_refs: [] })
    const { result } = renderHook(() => usePageAliases('page-1', t))
    await waitFor(() => {
      expect(result.current.aliases).toEqual(['Standup'])
    })

    act(() => {
      result.current.setAliasInput('standup')
    })
    act(() => {
      result.current.handleAddAlias()
    })

    await waitFor(() => {
      expect(result.current.aliasInput).toBe('')
    })
    expect(result.current.aliases).toEqual(['Standup'])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(mockedAnnounce).toHaveBeenCalledWith('announce.aliasAdded')
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
    let resolveSecond!: (value: { aliases: string[]; op_refs: never[] }) => void
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
      resolveSecond({ aliases: ['alpha'], op_refs: [] })
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

// #5249 — aliases are unlinked-reference search terms, and that panel (and its
// own alias copy) refreshes on the structure counter.
describe('usePageAliases — graph-structure counter', () => {
  it('a committed add and a committed remove each bump the counter', async () => {
    const { result } = renderHook(() => usePageAliases('page-1', t))
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled()
    })
    const before = getGraphStructureKey()

    act(() => {
      result.current.setAliasInput('Nickname')
    })
    act(() => {
      result.current.handleAddAlias()
    })
    await waitFor(() => {
      expect(getGraphStructureKey()).toBe(before + 1)
    })

    act(() => {
      result.current.handleRemoveAlias('Nickname')
    })
    await waitFor(() => {
      expect(getGraphStructureKey()).toBe(before + 2)
    })
  })
})

// #5387 — an alias edit is ops: it lands on the page's undo stack, and the list
// reloads when an Undo (or a sync / MCP write) invalidates the name caches.
describe('usePageAliases — undo', () => {
  it('a committed add and a committed remove each push their op refs onto the undo stack', async () => {
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
    await waitFor(() => {
      expect(useUndoStore.getState().pages.get('page-1')?.undoStack.at(-1)?.refs).toEqual([OP_REF])
    })

    mockedSet.mockResolvedValueOnce({ aliases: [], op_refs: [{ device_id: 'dev-1', seq: 8 }] })
    act(() => {
      result.current.handleRemoveAlias('Nickname')
    })
    await waitFor(() => {
      const refs = useUndoStore
        .getState()
        .pages.get('page-1')
        ?.undoStack.flatMap((entry) => entry.refs ?? [])
      expect(refs).toEqual([OP_REF, { device_id: 'dev-1', seq: 8 }])
    })
  })

  it('a write that appended nothing pushes no undo entry', async () => {
    mockedGet.mockResolvedValueOnce(['Standup'])
    mockedSet.mockResolvedValueOnce({ aliases: ['Standup'], op_refs: [] })
    const { result } = renderHook(() => usePageAliases('page-1', t))
    await waitFor(() => {
      expect(result.current.aliases).toEqual(['Standup'])
    })

    act(() => {
      result.current.setAliasInput('standup')
    })
    act(() => {
      result.current.handleAddAlias()
    })

    await waitFor(() => {
      expect(result.current.aliasInput).toBe('')
    })
    expect(useUndoStore.getState().pages.get('page-1')).toBeUndefined()
  })

  it('reloads the list on an invalidated name change, as an Undo emits', async () => {
    mockedGet.mockResolvedValueOnce(['alpha', 'beta'])
    const { result } = renderHook(() => usePageAliases('page-1', t))
    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha', 'beta'])
    })

    mockedGet.mockResolvedValueOnce(['alpha'])
    act(() => {
      invalidateNameCaches()
    })

    await waitFor(() => {
      expect(result.current.aliases).toEqual(['alpha'])
    })
    expect(mockedGet).toHaveBeenCalledTimes(2)
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
