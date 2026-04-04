/**
 * Tests for useDebouncedCallback hook.
 *
 * Validates:
 *  - Calls callback after delay
 *  - Resets timer on re-schedule
 *  - cancel() prevents callback
 *  - Cleans up on unmount
 *  - Multiple rapid calls only trigger last one
 */

import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedCallback } from '../useDebouncedCallback'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedCallback', () => {
  it('calls callback after delay', () => {
    const callback = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(callback, 300))

    act(() => {
      result.current.schedule('hello')
    })

    // Not called yet
    expect(callback).not.toHaveBeenCalled()

    // Advance past the delay
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('hello')
  })

  it('resets timer on re-schedule', () => {
    const callback = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(callback, 300))

    act(() => {
      result.current.schedule('first')
    })

    // Advance 200ms (not enough to fire)
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(callback).not.toHaveBeenCalled()

    // Re-schedule with a new value — timer restarts
    act(() => {
      result.current.schedule('second')
    })

    // Advance another 200ms — still not enough since timer was reset
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(callback).not.toHaveBeenCalled()

    // Advance the remaining 100ms
    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('second')
  })

  it('cancel() prevents callback', () => {
    const callback = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(callback, 300))

    act(() => {
      result.current.schedule('cancelled')
    })

    act(() => {
      result.current.cancel()
    })

    // Advance well past the delay
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(callback).not.toHaveBeenCalled()
  })

  it('cleans up on unmount', () => {
    const callback = vi.fn()

    const container = document.createElement('div')
    document.body.appendChild(container)

    let scheduleRef: ((value: string) => void) | null = null

    function TestComponent() {
      const debounced = useDebouncedCallback(callback, 300)
      scheduleRef = debounced.schedule
      return null
    }

    let root: Root
    act(() => {
      root = createRoot(container)
      root.render(createElement(TestComponent))
    })

    // Schedule a callback
    act(() => {
      scheduleRef?.('unmounted')
    })

    // Unmount the component
    act(() => {
      root.unmount()
    })

    // Advance past the delay — callback should NOT fire
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(callback).not.toHaveBeenCalled()

    document.body.removeChild(container)
  })

  it('multiple rapid calls only trigger last one', () => {
    const callback = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(callback, 300))

    act(() => {
      result.current.schedule('a')
      result.current.schedule('b')
      result.current.schedule('c')
      result.current.schedule('d')
      result.current.schedule('e')
    })

    // Advance past the delay
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('e')
  })
})
