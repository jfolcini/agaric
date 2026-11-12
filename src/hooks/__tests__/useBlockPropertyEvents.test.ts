/**
 * Tests useBlockPropertyEvents hook.
 *
 * Validates:
 *   - invalidationKey starts at 0
 *   - Increments when property change event fires
 *   - Debounces rapid consecutive events (150ms)
 *
 * #1818: the counter + listener now live at module scope
 * (`src/lib/block-property-events.ts`), so the hook is a thin
 * `useSyncExternalStore` adapter. Module state is reset between tests via
 * `_resetBlockPropertyEventsForTest`, and the listener only registers inside
 * Tauri (the `__TAURI_INTERNALS__` marker below).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const eventListeners = new Map<string, (event: unknown) => void>()

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

// The module-level listener only registers inside Tauri. Stamp the marker so
// the lazy-init path hits the mocked `listen()` above.
;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}

import {
  useBlockPropertyEvents,
  useScopedBlockPropertyEvents,
} from '@/hooks/useBlockPropertyEvents'
import {
  _resetBlockPropertyEventsForTest,
  EVENT_PROPERTY_CHANGED,
} from '@/lib/block-property-events'

beforeEach(() => {
  eventListeners.clear()
  _resetBlockPropertyEventsForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  _resetBlockPropertyEventsForTest()
})

function firePropertyEvent(blockId: string, keys: string[]) {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: blockId, changed_keys: keys } })
}

describe('useBlockPropertyEvents', () => {
  it('starts invalidationKey = 0', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    // Let async listener setup settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.invalidationKey).toBe(0)
  })

  it('increments invalidationKey on event + debounce', async () => {
    const { result } = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

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

  it('increments separately for events spaced beyond the debounce window', async () => {
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

  // #1818: the counter is module-level, so a mutation event that fires while
  // NO component is mounted is still observed — the next mount reads the bumped
  // key rather than a per-instance 0. This is the property that lets a
  // module-level consumer cache (e.g. GraphView's graphCacheMap) detect a
  // mutation that happened during its own unmount.
  it('survives unmount: an event fired while unmounted is reflected on remount', async () => {
    const first = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(first.result.current.invalidationKey).toBe(0)

    // Unmount the only consumer, then fire a mutation while nothing is mounted.
    first.unmount()
    act(() => {
      firePropertyEvent('BLK01', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // A fresh mount reads the module-level counter, which advanced to 1.
    const second = renderHook(() => useBlockPropertyEvents())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(second.result.current.invalidationKey).toBe(1)
  })
})

describe('useScopedBlockPropertyEvents', () => {
  // #2905 registers the fan-out target ONCE (empty dep array) so an `ownsBlock`
  // that changes identity on every render does not re-register the listener.
  // #4377 — that indirection used to be a latest-value ref mirror written
  // during render and is now a `useEffectEvent`. Either way the contract is the
  // same and is what this test pins: the registered target must consult the
  // ownership predicate from the LATEST commit, not the one captured when the
  // effect registered. Freeze the predicate at mount and this fails.
  it('consults the ownsBlock predicate from the latest render, not the one it registered with', async () => {
    const { result, rerender } = renderHook(
      ({ owned }: { owned: string }) =>
        useScopedBlockPropertyEvents({ ownsBlock: (blockId) => blockId === owned }),
      { initialProps: { owned: 'BLK01' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.invalidationKey).toBe(0)

    // An event for a block this instance does NOT own is ignored.
    act(() => {
      firePropertyEvent('BLK02', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(0)

    // Hand the hook a brand-new predicate that owns BLK02 instead.
    rerender({ owned: 'BLK02' })

    act(() => {
      firePropertyEvent('BLK02', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(1)

    // ...and the block it used to own is now ignored.
    act(() => {
      firePropertyEvent('BLK01', ['todo_state'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(result.current.invalidationKey).toBe(1)
  })
})
