import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import { useBlockMultiSelect } from '../useBlockMultiSelect'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

function makeBlock(id: string, parentId: string | null = null) {
  return {
    id,
    block_type: 'content' as const,
    content: `Block ${id}`,
    parent_id: parentId,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
    depth: 0,
  }
}

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
    blocks: [makeBlock('BLOCK_1'), makeBlock('BLOCK_2'), makeBlock('BLOCK_3')],
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
      blocks: [makeBlock('PARENT'), makeBlock('CHILD', 'PARENT')],
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
