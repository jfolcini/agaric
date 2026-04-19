/**
 * Tests for usePriorityLevels — React subscription to the priority level cache.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '../../lib/priority-levels'
import { usePriorityLevels } from '../usePriorityLevels'

beforeEach(() => {
  __resetPriorityLevelsForTests()
})

afterEach(() => {
  __resetPriorityLevelsForTests()
})

describe('usePriorityLevels', () => {
  it('returns the default levels on mount', () => {
    const { result } = renderHook(() => usePriorityLevels())
    expect(result.current).toEqual(['1', '2', '3'])
  })

  it('re-renders when setPriorityLevels is called', () => {
    const { result } = renderHook(() => usePriorityLevels())
    expect(result.current).toEqual(['1', '2', '3'])

    act(() => {
      setPriorityLevels(['A', 'B', 'C', 'D'])
    })

    expect(result.current).toEqual(['A', 'B', 'C', 'D'])
  })

  it('does not re-render when setPriorityLevels is a no-op', () => {
    let renderCount = 0
    renderHook(() => {
      renderCount++
      return usePriorityLevels()
    })
    const before = renderCount

    act(() => {
      setPriorityLevels(['1', '2', '3']) // same as default
    })

    // React.useSyncExternalStore only schedules a re-render when the
    // subscribe callback fires — we don't notify on no-op set.
    expect(renderCount).toBe(before)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => usePriorityLevels())
    unmount()
    // No assertion needed — React wires up the unsubscribe via
    // useSyncExternalStore. If unsubscribe leaks the listener, a later
    // `setPriorityLevels` would still try to schedule an update on a
    // disposed component. This test exists mainly as a smoke regression
    // guard for the wiring.
    expect(() => setPriorityLevels(['A', 'B'])).not.toThrow()
  })
})
