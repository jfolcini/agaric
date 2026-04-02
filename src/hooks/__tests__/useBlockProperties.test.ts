/**
 * Tests for useBlockProperties hook — task cycling and priority cycling.
 *
 * Validates:
 * - getTodoState reads from block store
 * - handleToggleTodo cycles none → TODO → DOING → DONE → none
 * - handleToggleTodo calls set_todo_state IPC command
 * - handleToggleTodo does optimistic update + revert on failure
 * - handleTogglePriority cycles none → A → B → C → none
 * - handleTogglePriority calls set_priority IPC command
 * - handleTogglePriority does optimistic update + revert on failure
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockStore } from '../../stores/blocks'
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
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: todoState,
    priority,
    due_date: null,
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
  it('cycles from none to A', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: 'A',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('A')
  })

  it('cycles from A to B', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'A')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: 'B',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('B')
  })

  it('cycles from B to C', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'B')] })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: 'C',
    })

    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('C')
  })

  it('cycles from C to none', async () => {
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'C')] })

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
    useBlockStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'A')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Should revert to original A priority
    const block = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('A')
  })

  it('does not affect other blocks in the store', async () => {
    useBlockStore.setState({
      blocks: [makeBlock('BLOCK_1', null, 'A'), makeBlock('BLOCK_2', 'TODO', 'B')],
    })

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // BLOCK_2 should be unchanged
    const block2 = useBlockStore.getState().blocks.find((b) => b.id === 'BLOCK_2')
    expect(block2?.priority).toBe('B')
    expect(block2?.todo_state).toBe('TODO')
  })
})
