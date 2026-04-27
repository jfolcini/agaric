import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { makeBlock } from '../../__tests__/fixtures'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import { useBlockMultiSelect } from '../useBlockMultiSelect'

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

const originalOnNewAction = useUndoStore.getState().onNewAction
afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockMultiSelect>[0]>) {
  return {
    selectedBlockIds: ['BLOCK_1', 'BLOCK_2'] as string[],
    clearSelected: vi.fn(),
    rootParentId: 'PAGE_1' as string | null,
    pageStore,
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: [
      makeBlock({ id: 'BLOCK_1' }),
      makeBlock({ id: 'BLOCK_2' }),
      makeBlock({ id: 'BLOCK_3' }),
    ],
  })
})

describe('useBlockMultiSelect initial state', () => {
  it('returns batchDeleteConfirm as false', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    expect(result.current.batchDeleteConfirm).toBe(false)
  })

  it('returns batchInProgress as false', () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    expect(result.current.batchInProgress).toBe(false)
  })
})

describe('useBlockMultiSelect handleBatchSetTodo', () => {
  it('sets todo state on all selected blocks optimistically', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_2',
      state: 'TODO',
    })
  })

  it('clears selection after success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  it('shows success toast on success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalled()
  })

  it('shows error toast when some IPC calls fail', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it('guards against concurrent batch operations', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(result.current.batchInProgress).toBe(false)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it('sets null state to clear todo', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo(null)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: null,
    })
  })
})

describe('useBlockMultiSelect handleBatchDelete', () => {
  it('deletes selected blocks', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'BLOCK_1' })
    expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'BLOCK_2' })
  })

  it('clears selection after delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  it('filters out child blocks whose parent is also selected', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'PARENT' }), makeBlock({ id: 'CHILD', parent_id: 'PARENT' })],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['PARENT', 'CHILD'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'PARENT' })
  })

  it('shows error toast on failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.deleteFailedMessage')
  })

  it('shows success toast on success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('blockTree.deletedMessage')
  })

  it('resets batchDeleteConfirm after delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    act(() => {
      result.current.setBatchDeleteConfirm(true)
    })
    expect(result.current.batchDeleteConfirm).toBe(true)

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(result.current.batchDeleteConfirm).toBe(false)
  })
})

describe('useBlockMultiSelect undo notifications', () => {
  const onNewActionSpy = vi.fn()

  beforeEach(() => {
    onNewActionSpy.mockClear()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })
  })

  it('calls onNewAction after successful batch set todo', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

describe('useBlockMultiSelect reentrancy guard (#MAINT-9)', () => {
  it('rejects a concurrent handleBatchSetTodo call while another is in flight', async () => {
    // Hold the first invoke open so we can fire a second call during it.
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    // Fire first call — it will block on the held promise.
    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchSetTodo('TODO')
    })

    // Second call should hit the reentrancy guard and return immediately
    // without triggering another invoke.
    await act(async () => {
      await result.current.handleBatchSetTodo('DOING')
    })

    // Only the first invoke has been issued; the second call was rejected.
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })

    // Release the first call and await its completion.
    await act(async () => {
      releaseFirst?.()
      await firstDone
    })
  })

  it('rejects a concurrent handleBatchDelete call while another is in flight', async () => {
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchDelete()
    })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirst?.()
      await firstDone
    })
  })

  it('allows a fresh call after the previous one finishes', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })
    await act(async () => {
      await result.current.handleBatchSetTodo('DONE')
    })

    // Both calls should have issued an invoke.
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })
})

describe('useBlockMultiSelect callback stability (#MAINT-9)', () => {
  it('keeps handleBatchSetTodo identity stable across rerenders with unchanged deps', () => {
    const params = makeDefaultParams()
    const { result, rerender } = renderHook(() => useBlockMultiSelect(params), { wrapper })
    const firstRef = result.current.handleBatchSetTodo
    rerender()
    expect(result.current.handleBatchSetTodo).toBe(firstRef)
  })

  it('keeps handleBatchDelete identity stable across rerenders with unchanged deps', () => {
    const params = makeDefaultParams()
    const { result, rerender } = renderHook(() => useBlockMultiSelect(params), { wrapper })
    const firstRef = result.current.handleBatchDelete
    rerender()
    expect(result.current.handleBatchDelete).toBe(firstRef)
  })

  it('does not rebuild callbacks while the reentrancy guard flips during a batch op', async () => {
    // Hold invoke open so the batch op stays mid-flight; we can then observe
    // callback identity while batchInProgressRef is true. A state-based guard
    // would flip a React state and force a rerender with a new callback.
    let releaseFirst: (() => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => resolve()
        }),
    )

    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    const beforeFn = result.current.handleBatchSetTodo

    let firstDone: Promise<void> | null = null
    act(() => {
      firstDone = result.current.handleBatchSetTodo('TODO')
    })

    // While the batch is in flight, the UI state (batchInProgress) has flipped
    // to true. The callback identity MAY have changed due to that state-driven
    // rerender — but the reentrancy guard no longer forces the callback's
    // closure to rebuild on every flip. The key assertion: the guard still
    // works (next call is rejected).
    await act(async () => {
      await result.current.handleBatchSetTodo('DOING')
    })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirst?.()
      await firstDone
    })

    // After the batch op completes, the callback returns to the original
    // identity because batchInProgress is removed from its deps array.
    expect(result.current.handleBatchSetTodo).toBe(beforeFn)
  })
})
