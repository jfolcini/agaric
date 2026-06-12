/**
 * Tests for the #133 usePullToDismiss gesture — downward drag past a
 * threshold dismisses; below threshold springs back; upward is clamped.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DISMISS_THRESHOLD, usePullToDismiss } from '../usePullToDismiss'

function pointerEvent(y: number): React.PointerEvent {
  return {
    clientY: y,
    pointerId: 1,
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    },
  } as unknown as React.PointerEvent
}

describe('usePullToDismiss', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (navigator as { vibrate?: unknown }).vibrate
  })

  it('tracks downward drag offset', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(0)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(30)))
    expect(result.current.dragY).toBe(30)
    expect(result.current.dragging).toBe(true)
  })

  it('clamps upward drags to zero', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(100)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(60)))
    expect(result.current.dragY).toBe(0)
  })

  it('dismisses when released past the threshold', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(0)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(DEFAULT_DISMISS_THRESHOLD + 10)))
    act(() => result.current.handlers.onPointerUp(pointerEvent(DEFAULT_DISMISS_THRESHOLD + 10)))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('springs back (no dismiss) when released below the threshold', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(0)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(20)))
    act(() => result.current.handlers.onPointerUp(pointerEvent(20)))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(result.current.dragY).toBe(0)
    expect(result.current.dragging).toBe(false)
  })

  it('fires a haptic on dismiss when the Vibration API is present', () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(0)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(120)))
    act(() => result.current.handlers.onPointerUp(pointerEvent(120)))
    expect(vibrate).toHaveBeenCalledWith(15)
  })

  it('respects a custom threshold', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => usePullToDismiss({ onDismiss, threshold: 200 }))
    act(() => result.current.handlers.onPointerDown(pointerEvent(0)))
    act(() => result.current.handlers.onPointerMove(pointerEvent(150)))
    act(() => result.current.handlers.onPointerUp(pointerEvent(150)))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
