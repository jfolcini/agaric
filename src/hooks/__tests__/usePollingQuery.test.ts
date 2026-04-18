import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePollingQuery } from '../usePollingQuery'

describe('usePollingQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Basic loading ──────────────────────────────────────────────

  it('fetches on mount', async () => {
    const queryFn = vi.fn().mockResolvedValue({ count: 42 })
    const { result } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.data).toEqual({ count: 42 })
    expect(result.current.error).toBeNull()
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('sets loading=true while the request is in flight', async () => {
    let resolve!: (v: string) => void
    const queryFn = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()

    await act(async () => resolve('done'))
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBe('done')
  })

  // ── Polling ────────────────────────────────────────────────────

  it('polls at the configured interval', async () => {
    const queryFn = vi.fn().mockResolvedValue('ok')
    renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryFn).toHaveBeenCalledTimes(1)

    // After 5s — second poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(queryFn).toHaveBeenCalledTimes(2)

    // After another 5s — third poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('clears interval on unmount', async () => {
    const queryFn = vi.fn().mockResolvedValue('ok')
    const { unmount } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryFn).toHaveBeenCalledTimes(1)

    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(queryFn).toHaveBeenCalledTimes(1) // no more calls
  })

  // ── Error handling ─────────────────────────────────────────────

  it('sets error state with errorMessage on failure', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() =>
      usePollingQuery(queryFn, { intervalMs: 5000, errorMessage: 'Load failed' }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.error).toBe('Load failed')
    expect(result.current.data).toBeNull()
  })

  it('clears error on successful poll', async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok')
    const { result } = renderHook(() =>
      usePollingQuery(queryFn, { intervalMs: 5000, errorMessage: 'Error' }),
    )

    // First call fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.error).toBe('Error')

    // Second call (at 5s) succeeds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe('ok')
  })

  // ── enabled flag ───────────────────────────────────────────────

  it('skips polling when enabled=false', async () => {
    const queryFn = vi.fn().mockResolvedValue('ok')
    renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000, enabled: false }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(queryFn).not.toHaveBeenCalled()
  })

  // ── refetchOnFocus ─────────────────────────────────────────────

  it('refetches on window focus when refetchOnFocus is true', async () => {
    const queryFn = vi.fn().mockResolvedValue('ok')
    renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000, refetchOnFocus: true }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryFn).toHaveBeenCalledTimes(1)

    // Simulate focus event
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('removes focus listener on unmount', async () => {
    const queryFn = vi.fn().mockResolvedValue('ok')
    const { unmount } = renderHook(() =>
      usePollingQuery(queryFn, { intervalMs: 60_000, refetchOnFocus: true }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    unmount()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryFn).toHaveBeenCalledTimes(1) // only the initial call
  })

  // ── refetch ────────────────────────────────────────────────────

  it('exposes a manual refetch function', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    const { result } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000 }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.data).toBe('first')

    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.data).toBe('second')
  })

  // ── Re-poll on queryFn change ──────────────────────────────────

  it('restarts polling when queryFn changes', async () => {
    const qf1 = vi.fn().mockResolvedValue('a')
    const qf2 = vi.fn().mockResolvedValue('b')

    const { result, rerender } = renderHook(
      ({ qf }: { qf: () => Promise<string> }) => usePollingQuery(qf, { intervalMs: 5000 }),
      { initialProps: { qf: qf1 } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.data).toBe('a')

    rerender({ qf: qf2 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.data).toBe('b')
  })

  // ── PERF-21: visibility-aware polling ──────────────────────────

  describe('document.hidden gating (PERF-21)', () => {
    let hiddenValue = false

    beforeEach(() => {
      hiddenValue = false
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hiddenValue,
      })
    })

    afterEach(() => {
      // Restore the default (spec says `hidden` is a non-configurable
      // read-only getter, but jsdom lets us redefine it — we still need
      // to clean up so the next test block starts fresh).
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      })
    })

    it('skips the initial load when the page is already hidden', async () => {
      hiddenValue = true
      const queryFn = vi.fn().mockResolvedValue('ok')
      renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(queryFn).not.toHaveBeenCalled()
    })

    it('interval ticks while hidden do not fire the query', async () => {
      const queryFn = vi.fn().mockResolvedValue('ok')
      renderHook(() => usePollingQuery(queryFn, { intervalMs: 5000 }))

      // Initial (visible) fetch lands
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      // Now the tab goes to the background — the next interval tick
      // fires but load() short-circuits.
      hiddenValue = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      // Another interval tick — still no fetch while hidden.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('fires a fresh load when the page becomes visible', async () => {
      hiddenValue = true
      const queryFn = vi.fn().mockResolvedValue('ok')
      renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000 }))

      // Initial load is skipped because hidden
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).not.toHaveBeenCalled()

      // Tab becomes visible
      hiddenValue = false
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('does not fire when visibilitychange fires while still hidden', async () => {
      const queryFn = vi.fn().mockResolvedValue('ok')
      renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000 }))
      // Initial visible fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      // Visibility event fires but we're still hidden — should NOT reload
      hiddenValue = true
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('removes the visibilitychange listener on unmount', async () => {
      const queryFn = vi.fn().mockResolvedValue('ok')
      const { unmount } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000 }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      unmount()

      // After unmount, dispatching visibilitychange MUST NOT trigger any
      // additional fetch — listener was cleaned up.
      hiddenValue = false
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('manual refetch() also short-circuits when hidden', async () => {
      const queryFn = vi.fn().mockResolvedValue('ok')
      const { result } = renderHook(() => usePollingQuery(queryFn, { intervalMs: 60_000 }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      hiddenValue = true
      await act(async () => {
        await result.current.refetch()
      })
      expect(queryFn).toHaveBeenCalledTimes(1)

      // Going visible and refetching works again
      hiddenValue = false
      await act(async () => {
        await result.current.refetch()
      })
      expect(queryFn).toHaveBeenCalledTimes(2)
    })
  })
})
