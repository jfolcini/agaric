import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
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
    t: vi.fn((key: string) => key) as unknown as TFunction,
    handleTogglePriority: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default mock: every batch IPC reports "all input ids handled".
  // Per-test overrides return specific counts to exercise the
  // affected-count branch in the toast logic.
  mockedInvoke.mockImplementation((cmd: string, args: unknown) => {
    if (cmd === 'set_todo_state_batch' || cmd === 'delete_blocks_by_ids') {
      const a = args as Record<string, unknown>
      const ids = (a['blockIds'] as string[]) ?? []
      return Promise.resolve(ids.length)
    }
    return Promise.resolve(undefined)
  })
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
  // Was N IPCs (one `set_todo_state` per block);
  // is now ONE `set_todo_state_batch` IPC carrying the whole id list.
  it('fires a single set_todo_state_batch IPC for the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
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

  it('shows error toast when the batch IPC fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetTodo('TODO')
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it('shows error toast when the backend silently skipped some ids', async () => {
    // Backend returns affected_count < ids.length when some ids are
    // missing or already-deleted. The hook surfaces that as a partial
    // failure so the user sees an honest summary.
    mockedInvoke.mockImplementationOnce((cmd: string) => {
      if (cmd === 'set_todo_state_batch') return Promise.resolve(1) // 1 of 2
      return Promise.resolve(undefined)
    })
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

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
      state: null,
    })
  })
})

describe('useBlockMultiSelect handleBatchSetPriority (#1734)', () => {
  // No dedicated single-IPC batch priority endpoint exists, so the toolbar
  // fans out the canonical per-block cycle (the same path the bulk context
  // menu uses) — one `handleTogglePriority` call per selected block.
  it('fans out handleTogglePriority across the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(params.handleTogglePriority).toHaveBeenCalledTimes(2)
    expect(params.handleTogglePriority).toHaveBeenCalledWith('BLOCK_1')
    expect(params.handleTogglePriority).toHaveBeenCalledWith('BLOCK_2')
  })

  it('clears selection after success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  it('resets batchInProgress after completion', async () => {
    const params = makeDefaultParams({ selectedBlockIds: ['BLOCK_1'] })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchSetPriority()
    })

    expect(result.current.batchInProgress).toBe(false)
  })
})

describe('useBlockMultiSelect handleBatchDelete', () => {
  // Was N IPCs (one `delete_block` per block); is
  // now ONE `delete_blocks_by_ids` IPC carrying the whole id list.
  // The backend's recursive CTE walks every root's subtree in one tx,
  // So the FE no longer needs the ancestor pre-walk.
  it('fires a single delete_blocks_by_ids IPC for the whole selection', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['BLOCK_1', 'BLOCK_2'],
    })
  })

  it('clears selection after delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(params.clearSelected).toHaveBeenCalled()
  })

  // The FE no longer pre-walks ancestors. The
  // backend's recursive CTE handles ancestor coalescing in one tx, so
  // even when both an ancestor and its descendant are selected the FE
  // sends the raw selection unchanged. Asserts the new behaviour:
  // single IPC, every selected id present in the payload.
  it('passes both ancestor and descendant ids through unchanged (backend coalesces)', async () => {
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
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', {
      blockIds: ['PARENT', 'CHILD'],
    })
  })

  // The ancestor-walk filter is gone (the
  // backend's recursive CTE seeded from every root subsumes the same
  // descendant set). Transitive descendants are passed through unchanged.
  it('passes transitive descendants through unchanged (backend coalesces via CTE)', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'A' }),
        makeBlock({ id: 'B', parent_id: 'A' }),
        makeBlock({ id: 'C', parent_id: 'B' }),
      ],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['A', 'C'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['A', 'C'] })
  })

  it('deletes independent siblings when neither is an ancestor of the other', async () => {
    pageStore.setState({
      blocks: [
        makeBlock({ id: 'A' }),
        makeBlock({ id: 'B', parent_id: 'A' }),
        makeBlock({ id: 'C' }),
        makeBlock({ id: 'D', parent_id: 'C' }),
      ],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['A', 'C'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['A', 'C'] })
  })

  it('deletes a block whose parent_id points to an id not in the store (orphan chain)', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'X', parent_id: 'MISSING' })],
    })
    const params = makeDefaultParams({
      selectedBlockIds: ['X'],
    })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_blocks_by_ids', { blockIds: ['X'] })
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

  it('shows success toast advertising the undo path on success', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    // C4 (#217): batch delete is reversible via the page op-log, so the
    // toast names the Ctrl+Z escape hatch instead of the bare count.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('blockTree.deletedMessageUndo')
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

  // C4 (#217): batch delete appends DeleteBlock ops to the page op-log,
  // so the toast advertises Ctrl+Z. We mark a new action (resetting the
  // redo stack) so the advertised undo lands on a clean slate.
  it('calls onNewAction after successful batch delete', async () => {
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('does not call onNewAction after a batch delete when rootParentId is null', async () => {
    const params = makeDefaultParams({ rootParentId: null })
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('does not call onNewAction after a failed batch delete', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const params = makeDefaultParams()
    const { result } = renderHook(() => useBlockMultiSelect(params), { wrapper })

    await act(async () => {
      await result.current.handleBatchDelete()
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

describe('useBlockMultiSelect reentrancy guard (#)', () => {
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
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state_batch', {
      blockIds: ['BLOCK_1'],
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

describe('useBlockMultiSelect callback stability (#)', () => {
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
