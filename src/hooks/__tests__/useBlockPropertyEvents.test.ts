/**
 * Tests for useBlockPropertyEvents hook.
 *
 * Validates:
 * - invalidationKey starts at 0
 * - Increments when a property change event fires
 * - Debounces rapid consecutive events (150ms)
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let eventListeners: Map<string, (event: unknown) => void>

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

import { useBlockPropertyEvents } from '../useBlockPropertyEvents'

beforeEach(() => {
  eventListeners = new Map()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function firePropertyEvent(blockId: string, keys: string[]) {
  const handler = eventListeners.get('block:properties-changed')
  if (handler) {
    handler({ payload: { block_id: blockId, changed_keys: keys } })
  }
}

describe('useBlockPropertyEvents', () => {
  it('starts with invalidationKey = 0', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    // Wait for async setup
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.invalidationKey).toBe(0)
  })

  it('increments invalidationKey after event + debounce', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      firePropertyEvent('BLK01', ['todo_state'])
    })

    // Before debounce expires
    expect(result.current.invalidationKey).toBe(0)

    // After debounce (150ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(1)
  })

  it('debounces rapid consecutive events into single increment', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Fire 3 events in quick succession
    act(() => {
      firePropertyEvent('BLK01', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    act(() => {
      firePropertyEvent('BLK02', ['due_date'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    act(() => {
      firePropertyEvent('BLK03', ['scheduled_date'])
    })

    // Still 0 — debounce hasn't expired
    expect(result.current.invalidationKey).toBe(0)

    // After full debounce from last event
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(1)
  })

  it('increments separately for events spaced beyond debounce window', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // First event
    act(() => {
      firePropertyEvent('BLK01', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(1)

    // Second event after debounce window
    act(() => {
      firePropertyEvent('BLK02', ['due_date'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(2)
  })
})
