/**
 * Tests for the #135 useLongPress primitive — fires after a held,
 * stationary press; cancels on movement / early release.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_LONG_PRESS_DELAY, useLongPress } from '../useLongPress'

function pointerEvent(x: number, y: number): React.PointerEvent {
  return { clientX: x, clientY: y } as React.PointerEvent
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onLongPress after the delay elapses with no movement', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    expect(onLongPress).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('does not fire if released before the delay', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY - 50))
    act(() => result.current.onPointerUp())
    act(() => vi.advanceTimersByTime(100))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels when the pointer moves past the threshold (scroll intent)', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => result.current.onPointerMove(pointerEvent(0, 40)))
    act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('still fires on sub-threshold jitter', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => result.current.onPointerMove(pointerEvent(2, 3)))
    act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancels on pointer-leave', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => result.current.onPointerLeave())
    act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('respects a custom delay', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ onLongPress, delay: 1000 }))
    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => vi.advanceTimersByTime(600))
    expect(onLongPress).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})
