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

import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { usePageCreation } from '../usePageCreation'

// Partial tauri mock — only `createPageInSpace` is exercised here.
vi.mock('../../lib/tauri', () => ({
  createPageInSpace: vi.fn(),
}))

// Primary-focus registration is a side effect unrelated to creation logic.
vi.mock('../usePrimaryFocus', () => ({
  useRegisterPrimaryFocus: vi.fn(),
}))

import { isConflict } from '../../lib/app-error'
import { createPageInSpace } from '../../lib/tauri'

const mockedCreate = vi.mocked(createPageInSpace)
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

    expect(mockedCreate).toHaveBeenCalledWith({ content: 'My Page', spaceId: 'SPACE_A' })
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

    const arg = mockedCreate.mock.calls[0]?.[0]
    expect(typeof arg?.content).toBe('string')
    expect(arg?.content.length ?? 0).toBeGreaterThan(0)
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
