/**
 * Tests for usePageCreation — the create-page flow extracted from
 * `PageBrowser` (#1263). Covers the optimistic-prepend path, the
 * chips-active reload path, duplicate-name vs generic error toasts, the
 * space-not-ready guard, and the count-chip bump.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePageCreation } from '@/hooks/usePageCreation'
import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '@/lib/bindings'
import { useSpaceStore } from '@/stores/space'

// #2927 phase 7 — `usePageCreation` calls `commands.createPageInSpace` from
// `@/lib/bindings` directly. The spy sees the real wire arguments
// `(parentId, content, spaceId)`; the shim wraps a fulfilment in the
// `{ status: 'ok', data }` envelope `unwrap` expects.
const mockedCreate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      createPageInSpace: (...args: unknown[]) =>
        mockedCreate(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

// Primary-focus registration is a side effect unrelated to creation logic.
vi.mock('@/hooks/usePrimaryFocus', () => ({
  useRegisterPrimaryFocus: vi.fn(),
}))

import { isConflict } from '@/lib/app-error'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'

const mockedToastError = vi.mocked(toast.error)

type Row = BlockRow | PageWithMetadataRow

interface Harness {
  setPages: ReturnType<typeof vi.fn>
  setDisplayTotalCount: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  onPageSelect: ReturnType<typeof vi.fn>
}

function makeHarness(wireFilters: FilterPrimitive[] = []): Harness & {
  render: () => ReturnType<typeof renderHook<ReturnType<typeof usePageCreation>, void>>
} {
  const setPages = vi.fn()
  const setDisplayTotalCount = vi.fn()
  const reload = vi.fn()
  const onPageSelect = vi.fn()
  return {
    setPages,
    setDisplayTotalCount,
    reload,
    onPageSelect,
    render: () =>
      renderHook(() =>
        usePageCreation({
          wireFilters,
          reload,
          setPages: setPages as unknown as Dispatch<SetStateAction<Row[]>>,
          setDisplayTotalCount: setDisplayTotalCount as unknown as Dispatch<
            SetStateAction<number | undefined>
          >,
          onPageSelect,
        }),
      ),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_A', isReady: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePageCreation', () => {
  it('optimistically prepends a page and bumps the count when no chips are active', async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000000')
    const h = makeHarness([])
    const { result } = h.render()

    act(() => {
      result.current.setNewPageName('My Page')
    })
    await act(async () => {
      await result.current.handleCreatePage()
    })

    expect(mockedCreate).toHaveBeenCalledWith(null, 'My Page', 'SPACE_A')
    expect(h.reload).not.toHaveBeenCalled()
    // Prepend updater produces [new, ...prev].
    const updater = h.setPages.mock.calls[0]?.[0] as (prev: Row[]) => Row[]
    const next = updater([{ id: 'OLD' } as Row])
    expect(next.map((r) => r.id)).toEqual(['NEW_ID_0000000000000000000', 'OLD'])
    // Count bump: +1 when a number, untouched otherwise.
    const countUpdater = h.setDisplayTotalCount.mock.calls[0]?.[0] as (
      cur: number | undefined,
    ) => number | undefined
    expect(countUpdater(5)).toBe(6)
    expect(countUpdater(undefined)).toBeUndefined()
    expect(h.onPageSelect).toHaveBeenCalledWith('NEW_ID_0000000000000000000', 'My Page')
  })

  // #4338 — the Pages view has no `useBlockResolve()` to register with, so
  // the bus is its only route to the `[[` picker's cache. A page the user has
  // just NAMED here is the page they are most likely to link to next.
  it("publishes an 'added' event so the picker cache learns the new page", async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000009')
    const h = makeHarness([])
    const { result } = h.render()

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      act(() => {
        result.current.setNewPageName('Quarterly Review')
      })
      await act(async () => {
        await result.current.handleCreatePage()
      })
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      {
        kind: 'added',
        entity: 'page',
        id: 'NEW_ID_0000000000000000009',
        name: 'Quarterly Review',
        spaceId: 'SPACE_A',
      },
    ])
  })

  it('publishes nothing when the create IPC rejects', async () => {
    mockedCreate.mockRejectedValue(new Error('Disk full'))
    const h = makeHarness([])
    const { result } = h.render()

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      await act(async () => {
        await result.current.handleCreatePage()
      })
    } finally {
      unsubscribe()
    }

    // A cache told about a page that does not exist would offer a `[[` link
    // resolving to nothing.
    expect(changes).toEqual([])
  })

  it('reloads (no optimistic prepend) when chips are active', async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000001')
    const h = makeHarness([{ kind: 'orphan' } as unknown as FilterPrimitive])
    const { result } = h.render()

    await act(async () => {
      await result.current.handleCreatePage()
    })

    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.setPages).not.toHaveBeenCalled()
    expect(h.setDisplayTotalCount).not.toHaveBeenCalled()
  })

  it('falls back to the untitled name when the input is blank', async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000002')
    const h = makeHarness([])
    const { result } = h.render()

    await act(async () => {
      await result.current.handleCreatePage()
    })

    // Wire args are `(parentId, content, spaceId)` — a top-level page, so
    // `parentId` is an explicit `null`.
    const [parentId, content] = mockedCreate.mock.calls[0] ?? []
    expect(parentId).toBeNull()
    expect(typeof content).toBe('string')
    expect((content as string).length).toBeGreaterThan(0)
  })

  it('guards against a not-yet-ready space and never calls the IPC', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    const h = makeHarness([])
    const { result } = h.render()

    await act(async () => {
      await result.current.handleCreatePage()
    })

    expect(mockedCreate).not.toHaveBeenCalled()
    expect(mockedToastError).toHaveBeenCalledTimes(1)
  })

  it('shows a duplicate-name toast on a conflict error', async () => {
    const conflict = { kind: 'conflict', message: 'dup' }
    expect(isConflict(conflict)).toBe(true)
    mockedCreate.mockRejectedValue(conflict)
    const h = makeHarness([])
    const { result } = h.render()

    await act(async () => {
      await result.current.handleCreatePage()
    })

    await waitFor(() => expect(mockedToastError).toHaveBeenCalledTimes(1))
    // A conflict toast carries no Retry action.
    const opts = mockedToastError.mock.calls[0]?.[1]
    expect(opts).toBeUndefined()
  })

  it('shows a retryable toast on a generic error', async () => {
    mockedCreate.mockRejectedValue(new Error('db down'))
    const h = makeHarness([])
    const { result } = h.render()

    await act(async () => {
      await result.current.handleCreatePage()
    })

    await waitFor(() => expect(mockedToastError).toHaveBeenCalledTimes(1))
    const opts = mockedToastError.mock.calls[0]?.[1] as { action?: { label: string } } | undefined
    expect(opts?.action?.label).toBeTruthy()
  })

  it('handleCreateUnder seeds the namespace prefix and schedules a focus timer', () => {
    vi.useFakeTimers()
    const h = makeHarness([])
    const { result } = h.render()

    act(() => {
      result.current.handleCreateUnder('work')
    })
    expect(result.current.newPageName).toBe('work/')
    // Timer scheduled; flushing it must not throw (form ref is unattached).
    act(() => {
      vi.runAllTimers()
    })
  })
})
