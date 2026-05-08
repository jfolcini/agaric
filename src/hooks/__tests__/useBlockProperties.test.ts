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
import { makeBlock } from '../../__tests__/fixtures'
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

const originalOnNewAction = useUndoStore.getState().onNewAction

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
  pageStore = createPageBlockStore('PAGE_1')
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

describe('useBlockProperties getTodoState', () => {
  it('returns todo_state from block store', () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    expect(result.current.getTodoState('BLOCK_1')).toBe('TODO')
  })

  it('returns null when block has no todo_state', () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DOING' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DONE' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'CANCELLED' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })
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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '2' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '3' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: 'X' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })] })
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
      blocks: [
        makeBlock({ id: 'BLOCK_1', priority: '1' }),
        makeBlock({ id: 'BLOCK_2', todo_state: 'TODO', priority: '2' }),
      ],
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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to set task state')
  })

  it('announces new state via announcer on successful toggle', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // none → TODO, display label is "To do"
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: To do')
  })

  it('announces "none" when cycling back to no state', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'CANCELLED' })] })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // CANCELLED → none
    expect(mockedAnnounce).toHaveBeenCalledWith('Task state: none')
  })

  it('does not announce on IPC failure', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })] })
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
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })] })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to set priority')
  })

  it('does not call toast error on successful toggle', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })] })

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
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })],
      rootParentId: 'PAGE_1',
    })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleTogglePriority calls onNewAction after successful IPC', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })],
      rootParentId: 'PAGE_1',
    })

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
  })

  it('handleToggleTodo does not call onNewAction on IPC failure', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'TODO' })],
      rootParentId: 'PAGE_1',
    })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })

  it('handleTogglePriority does not call onNewAction on IPC failure', async () => {
    pageStore.setState({
      blocks: [makeBlock({ id: 'BLOCK_1', priority: '1' })],
      rootParentId: 'PAGE_1',
    })
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// F-37: dependency warning when cycling to DONE on a blocked task (UX-325)
// ---------------------------------------------------------------------------

const mockedToastWarning = vi.mocked(toast.warning)

describe('useBlockProperties handleToggleTodo F-37 dependency warning', () => {
  /**
   * Route both `set_todo_state` and `get_property` IPC calls. The
   * gutter-cycle path fires the dependency check fire-and-forget after
   * the state-change IPC resolves — tests must let microtasks flush
   * before asserting on the warning toast.
   *
   * PEND-35 Tier 2.4c — the dependency probe used to fetch the full
   * property vocabulary and `find` the `blocked_by` row in JS. After
   * Tier 2.4c it issues a single-key PK lookup against `get_property`,
   * so this helper simulates that one row directly.
   */
  function mockInvokeWithProperties(props: Array<Partial<{ key: string; value_ref: string }>>) {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === 'get_property') {
        const requestedKey = (args as { key: string } | undefined)?.key
        const match = props.find((p) => (p.key ?? '') === requestedKey)
        if (!match) return null
        return {
          key: match.key ?? '',
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: match.value_ref ?? null,
        }
      }
      return undefined
    })
  }

  it('fires toast.warning when cycling DOING → DONE on a block with unresolved blocked_by', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DOING' })] })
    mockInvokeWithProperties([{ key: 'blocked_by', value_ref: 'BLOCK_DEP' }])

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
      // Flush the fire-and-forget getProperties() promise chain.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedToastWarning).toHaveBeenCalledWith(
      'This task has dependencies that may not be complete',
    )
  })

  it('does not fire toast.warning when cycling to DONE on a block without blocked_by', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DOING' })] })
    mockInvokeWithProperties([])

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedToastWarning).not.toHaveBeenCalled()
  })

  it('does not fire toast.warning when cycling to a non-DONE state on a blocked task', async () => {
    // Cycling none → TODO; even though blocked_by is set, the warning
    // is only contractually fired on DONE.
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1' })] })
    mockInvokeWithProperties([{ key: 'blocked_by', value_ref: 'BLOCK_DEP' }])

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedToastWarning).not.toHaveBeenCalled()
  })

  it('does not fire toast.warning when cycling DONE → CANCELLED on a blocked task', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DONE' })] })
    mockInvokeWithProperties([{ key: 'blocked_by', value_ref: 'BLOCK_DEP' }])

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedToastWarning).not.toHaveBeenCalled()
  })

  it('does not fire toast.warning when blocked_by has no value_ref (unresolved-only check)', async () => {
    pageStore.setState({ blocks: [makeBlock({ id: 'BLOCK_1', todo_state: 'DOING' })] })
    mockInvokeWithProperties([{ key: 'blocked_by' }])

    const { result } = renderHook(() => useBlockProperties(), { wrapper })

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockedToastWarning).not.toHaveBeenCalled()
  })
})
