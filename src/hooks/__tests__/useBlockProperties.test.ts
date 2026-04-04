/**
 * Tests for useBlockProperties hook — task cycling and priority cycling.
 *
 * Validates:
 * - getTodoState reads from block store
 * - handleToggleTodo cycles none → TODO → DOING → DONE → none
 * - handleToggleTodo calls set_todo_state IPC command
 * - handleToggleTodo does optimistic update + revert on failure
 * - handleTogglePriority cycles none → 1 → 2 → 3 → none
 * - handleTogglePriority calls set_priority IPC command
 * - handleTogglePriority does optimistic update + revert on failure
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { announce } from '../../lib/announcer'
import { useBlockStore } from '../../stores/blocks'
import { useUndoStore } from '../../stores/undo'
import { useBlockProperties } from '../useBlockProperties'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, todoState: string | null = null, priority: string | null = null) {
  return {
    id,
    block_type: 'content' as const,
    content: `Block ${id}`,
    parent_id: null,
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: todoState,
    priority,
    due_date: null,
    scheduled_date: null,
    depth: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  useBlockStore.setState({
    blocks: [],
    rootParentId: null,
    focusedBlockId: null,
    loading: false,
  })
})

describe('useBlockProperties getTodoState', () => {
  it('returns todo_state from block store', () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })

    const { result } = renderHook(() => useBlockProperties())

    expect(result.current.getTodoState('BLOCK_1')).toBe('TODO')
  })

  it('returns null when block has no todo_state', () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties())

    expect(result.current.getTodoState('BLOCK_1')).toBeNull()
  })

  it('returns null for nonexistent block', () => {
    const { result } = renderHook(() => useBlockProperties())

    expect(result.current.getTodoState('NONEXISTENT')).toBeNull()
  })
})

describe('useBlockProperties handleToggleTodo', () => {
  it('cycles from none to TODO', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })

    // Block store should be updated
    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('TODO')
  })

  it('cycles from TODO to DOING', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'DOING',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('DOING')
  })

  it('cycles from DOING to DONE', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'DOING')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'DONE',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('DONE')
  })

  it('cycles from DONE to none', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'DONE')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: null,
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBeNull()
  })

  it('reverts optimistic update on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // Should revert to original TODO state
    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('TODO')
  })
})

describe('useBlockProperties handleTogglePriority', () => {
  it('cycles from none to 1', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '1',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('1')
  })

  it('cycles from 1 to 2', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '2',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('2')
  })

  it('cycles from 2 to 3', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '2')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '3',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('3')
  })

  it('cycles from 3 to none', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '3')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: null,
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBeNull()
  })

  it('handles unknown priority value by cycling to none', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'X')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // indexOf('X') returns -1, (-1 + 1) % 4 = 0 → null
    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: null,
    })
  })

  it('reverts optimistic update on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Should revert to original 1 priority
    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('1')
  })

  it('does not affect other blocks in the store', async () => {
    useBlockStore.setState({
      blocks: [makeBlock('BLOCK_1', null, '1'), makeBlock('BLOCK_2', 'TODO', '2')],
    })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // BLOCK_2 should be unchanged
    const block2 = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_2')
    expect(block2?.priority).toBe('2')
    expect(block2?.todo_state).toBe('TODO')
  })
})

// ---------------------------------------------------------------------------
// Toast error and announcer tests
// ---------------------------------------------------------------------------

const mockedToastError = vi.mocked(toast.error)
const mockedAnnounce = vi.mocked(announce)

describe('useBlockProperties handleToggleTodo toast and announcer', () => {
  it('shows toast error on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to update task state')
  })

  it('announces new state via announcer on successful toggle', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // none → TODO, display label is "To do"
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: To do')
  })

  it('announces "none" when cycling back to no state', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'DONE')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // DONE → none
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: none')
  })

  it('does not announce on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedAnnounce).not.toHaveBeenCalled()
  })
})

describe('useBlockProperties handleTogglePriority toast and announcer', () => {
  it('shows toast error on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to update priority')
  })

  it('does not call toast error on successful toggle', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedToastError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Undo store notification tests
// ---------------------------------------------------------------------------

describe('useBlockProperties undo notifications', () => {
  const onNewActionSpy = vi.fn((_pageId: string) => {})

  beforeEach(() => {
    onNewActionSpy.mockClear()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })
  })

  it('handleToggleTodo calls onNewAction after successful IPC', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')], rootParentId: 'PAGE_1' })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleTogglePriority calls onNewAction after successful IPC', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')], rootParentId: 'PAGE_1' })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleToggleTodo does not call onNewAction on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')], rootParentId: 'PAGE_1' })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('handleTogglePriority does not call onNewAction on IPC failure', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')], rootParentId: 'PAGE_1' })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})
