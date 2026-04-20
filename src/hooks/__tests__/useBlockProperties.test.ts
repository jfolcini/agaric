/**
 * Tests for useBlockProperties hook — task cycling and priority cycling.
 *
 * Validates:
 * - getTodoState reads from block store
 * - handleToggleTodo cycles none → TODO → DOING → DONE → CANCELLED → none (UX-202/UX-234)
 * - handleToggleTodo calls set_todo_state IPC command
 * - handleToggleTodo does optimistic update + revert on failure
 * - handleTogglePriority cycles none → 1 → 2 → 3 → none
 * - handleTogglePriority calls set_priority IPC command
 * - handleTogglePriority does optimistic update + revert on failure
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { announce } from '../../lib/announcer'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '../../lib/priority-levels'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import { useBlockProperties } from '../useBlockProperties'

vi.mock('../../lib/announcer', () => ({ announce: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

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
    page_id: null,
    depth: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  pageStore = createPageBlockStore('PAGE_1')
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('useBlockProperties getTodoState', () => {
  it('returns todo_state from block store', () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    expect(result.current.getTodoState('BLOCK_1')).toBe('TODO')
  })

  it('returns null when block has no todo_state', () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    expect(result.current.getTodoState('BLOCK_1')).toBeNull()
  })

  it('returns null for nonexistent block', () => {
    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    expect(result.current.getTodoState('NONEXISTENT')).toBeNull()
  })
})

describe('useBlockProperties handleToggleTodo', () => {
  it('cycles from none to TODO', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })

    // Block store should be updated
    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('TODO')
  })

  it('cycles from TODO to DOING', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'DOING',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('DOING')
  })

  it('cycles from DOING to DONE (UX-202/UX-234)', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'DOING')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'DONE',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('DONE')
  })

  it('cycles from DONE to CANCELLED (UX-202/UX-234)', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'DONE')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'CANCELLED',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('CANCELLED')
  })

  it('cycles from CANCELLED to none', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'CANCELLED')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: null,
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBeNull()
  })

  it('reverts optimistic update on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // Should revert to original TODO state
    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.todo_state).toBe('TODO')
  })

  it('completes a full cycle: null → TODO → DOING → DONE → CANCELLED → null (UX-202/UX-234)', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    const expected: Array<string | null> = ['TODO', 'DOING', 'DONE', 'CANCELLED', null]
    for (const state of expected) {
      await act(async () => {
        await result.current.handleToggleTodo('BLOCK_1')
      })
      const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
      expect(block?.todo_state).toStrictEqual(state)
    }
  })
})

describe('useBlockProperties handleTogglePriority', () => {
  it('cycles from none to 1', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '1',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('1')
  })

  it('cycles from 1 to 2', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '2',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('2')
  })

  it('cycles from 2 to 3', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '2')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: '3',
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('3')
  })

  it('cycles from 3 to none', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '3')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: null,
    })

    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBeNull()
  })

  it('handles unknown priority value by cycling to none', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, 'X')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

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
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Should revert to original 1 priority
    const block = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')
    expect(block?.priority).toBe('1')
  })

  it('does not affect other blocks in the store', async () => {
    pageStore.setState({
      blocks: [makeBlock('BLOCK_1', null, '1'), makeBlock('BLOCK_2', 'TODO', '2')],
    })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // BLOCK_2 should be unchanged
    const block2 = pageStore.getState().blocks.find((b) => b.id === 'BLOCK_2')
    expect(block2?.priority).toBe('2')
    expect(block2?.todo_state).toBe('TODO')
  })
})

// ---------------------------------------------------------------------------
// UX-201b: configurable priority cycle
// ---------------------------------------------------------------------------

describe('useBlockProperties handleTogglePriority — configurable levels (UX-201b)', () => {
  it('reads the cycle at click time (not at hook mount)', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    // Extend the level set AFTER the hook has mounted — the handler must
    // still pick up the new cycle on the next toggle.
    setPriorityLevels(['1', '2', '3', '4'])

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')?.priority).toBe('1')

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')?.priority).toBe('2')

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')?.priority).toBe('3')

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    // NEW level — previously this would have cycled back to null.
    expect(pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')?.priority).toBe('4')

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(pageStore.getState().blocks.find((b) => b.id === 'BLOCK_1')?.priority).toBeNull()
  })

  it('cycles through custom alphabetical levels', async () => {
    setPriorityLevels(['High', 'Mid', 'Low'])
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(mockedInvoke).toHaveBeenLastCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: 'High',
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })
    expect(mockedInvoke).toHaveBeenLastCalledWith('set_priority', {
      blockId: 'BLOCK_1',
      level: 'Mid',
    })
  })
})

// ---------------------------------------------------------------------------
// Toast error and announcer tests
// ---------------------------------------------------------------------------

const mockedToastError = vi.mocked(toast.error)
const mockedAnnounce = vi.mocked(announce)

describe('useBlockProperties handleToggleTodo toast and announcer', () => {
  it('shows toast error on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to set task state')
  })

  it('announces new state via announcer on successful toggle', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // none → TODO, display label is "To do"
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: To do')
  })

  it('announces "none" when cycling back to no state', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'CANCELLED')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // CANCELLED → none
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: none')
  })

  it('does not announce on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedAnnounce).not.toHaveBeenCalled()
  })
})

describe('useBlockProperties handleTogglePriority toast and announcer', () => {
  it('shows toast error on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to set priority')
  })

  it('does not call toast error on successful toggle', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

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
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')], rootParentId: 'PAGE_1' })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleTogglePriority calls onNewAction after successful IPC', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')], rootParentId: 'PAGE_1' })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleToggleTodo does not call onNewAction on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', 'TODO')], rootParentId: 'PAGE_1' })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('handleTogglePriority does not call onNewAction on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock('BLOCK_1', null, '1')], rootParentId: 'PAGE_1' })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})
