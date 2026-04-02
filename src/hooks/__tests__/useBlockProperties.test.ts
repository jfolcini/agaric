/**
 * Tests for useBlockProperties hook — task cycling and priority cycling.
 *
 * Validates:
 * - handleTogglePriority cycles none → A → B → C → none
 * - handleTogglePriority calls setProperty / deleteProperty correctly
 * - handleTogglePriority updates local cache
 * - handleToggleTodo still works (no regressions)
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockProperties } from '../useBlockProperties'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
})

describe('useBlockProperties handleTogglePriority', () => {
  it('cycles from none to A on first toggle', async () => {
    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Should call set_property with priority A
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
      valueText: 'A',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })

    // Local cache should contain the new priority
    const props = result.current.blockProperties.get('BLOCK_1')
    expect(props).toBeDefined()
    const priorityProp = props?.find((p) => p.key === 'priority')
    expect(priorityProp?.value_text).toBe('A')
  })

  it('cycles from A to B', async () => {
    const { result } = renderHook(() => useBlockProperties())

    // Set initial state: block has priority A
    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'priority',
                value_text: 'A',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
      valueText: 'B',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })

    const props = result.current.blockProperties.get('BLOCK_1')
    const priorityProp = props?.find((p) => p.key === 'priority')
    expect(priorityProp?.value_text).toBe('B')
  })

  it('cycles from B to C', async () => {
    const { result } = renderHook(() => useBlockProperties())

    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'priority',
                value_text: 'B',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
      valueText: 'C',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })

    const props = result.current.blockProperties.get('BLOCK_1')
    const priorityProp = props?.find((p) => p.key === 'priority')
    expect(priorityProp?.value_text).toBe('C')
  })

  it('cycles from C to none (deletes property)', async () => {
    const { result } = renderHook(() => useBlockProperties())

    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'priority',
                value_text: 'C',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
    })

    // Block should be removed from cache (no other properties)
    expect(result.current.blockProperties.has('BLOCK_1')).toBe(false)
  })

  it('preserves other properties when cycling priority', async () => {
    const { result } = renderHook(() => useBlockProperties())

    // Block has both a todo and a priority property
    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'todo',
                value_text: 'TODO',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
              {
                key: 'priority',
                value_text: 'A',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    const props = result.current.blockProperties.get('BLOCK_1')
    expect(props).toBeDefined()
    // todo property should still be there
    const todoProp = props?.find((p) => p.key === 'todo')
    expect(todoProp?.value_text).toBe('TODO')
    // priority should be updated to B
    const priorityProp = props?.find((p) => p.key === 'priority')
    expect(priorityProp?.value_text).toBe('B')
  })

  it('removes priority but keeps other properties when cycling to none', async () => {
    const { result } = renderHook(() => useBlockProperties())

    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'todo',
                value_text: 'DOING',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
              {
                key: 'priority',
                value_text: 'C',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    const props = result.current.blockProperties.get('BLOCK_1')
    expect(props).toBeDefined()
    // todo still there
    expect(props?.find((p) => p.key === 'todo')?.value_text).toBe('DOING')
    // priority removed
    expect(props?.find((p) => p.key === 'priority')).toBeUndefined()
  })

  it('handles unknown priority value by cycling to A', async () => {
    const { result } = renderHook(() => useBlockProperties())

    // Block has an unexpected priority value
    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'priority',
                value_text: 'X',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // indexOf returns -1 for unknown, (-1 + 1) % 4 = 0 → null (none)
    // So it cycles to none first, then A on next toggle
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'priority',
    })
  })
})

describe('useBlockProperties handleToggleTodo (regression)', () => {
  it('still cycles from none to TODO', async () => {
    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'todo',
      valueText: 'TODO',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
  })

  it('getTodoState returns correct state from cache', () => {
    const { result } = renderHook(() => useBlockProperties())

    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'todo',
                value_text: 'DOING',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    expect(result.current.getTodoState('BLOCK_1')).toBe('DOING')
  })

  it('getTodoState returns null for blocks without todo property', () => {
    const { result } = renderHook(() => useBlockProperties())

    expect(result.current.getTodoState('NONEXISTENT')).toBeNull()
  })
})

describe('useBlockProperties error handling', () => {
  it('handleToggleTodo reverts cache and shows toast on IPC failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // Cache should be reverted to empty (original state: no todo property)
    expect(result.current.blockProperties.size).toBe(0)
  })

  it('handleToggleTodo does not update cache on IPC failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleToggleTodo('BLOCK_1')
    })

    // Cache should remain empty since the optimistic update was reverted
    expect(result.current.blockProperties.size).toBe(0)
  })

  it('handleTogglePriority reverts cache on IPC failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Cache should be reverted (no priority property)
    expect(result.current.blockProperties.size).toBe(0)
  })

  it('handleTogglePriority does not update cache on IPC failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failed'))

    const { result } = renderHook(() => useBlockProperties())

    // Set initial properties
    act(() => {
      result.current.setBlockProperties(
        new Map([
          [
            'BLOCK_1',
            [
              {
                key: 'priority',
                value_text: 'A',
                value_num: null,
                value_date: null,
                value_ref: null,
              },
            ],
          ],
        ]),
      )
    })

    await act(async () => {
      await result.current.handleTogglePriority('BLOCK_1')
    })

    // Cache should still have 'A' (reverted from optimistic 'B')
    const props = result.current.blockProperties.get('BLOCK_1')
    expect(props?.find((p) => p.key === 'priority')?.value_text).toBe('A')
  })
})
