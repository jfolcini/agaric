/**
 * Tests for useScreenWakeLock (#3852).
 *
 * The behaviour under test is not "a wake lock is a nice idea" — it is that the
 * screen stays awake for exactly the window a pairing handshake is in flight,
 * because on Android 15+ a sleeping screen puts the app's uid into
 * `FIREWALL_CHAIN_BACKGROUND` and every packet is dropped at the cgroup-BPF hook.
 * So each assertion below pins one edge of that window: acquire on open, release
 * on close, release on unmount, and re-acquire after the page comes back.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useScreenWakeLock } from '@/hooks/useScreenWakeLock'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

interface FakeSentinel {
  release: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  fireRelease: () => void
}

function makeSentinel(): FakeSentinel {
  const listeners: Array<() => void> = []
  return {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.push(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
    }),
    fireRelease: () => {
      // slice() rather than iterating `listeners` directly: a listener that
      // removes itself while firing would otherwise shift the array under the
      // loop and skip its successor. `.slice()` not `[...]` only because
      // oxlint's no-useless-spread cannot see that the copy is the point.
      for (const listener of listeners.slice()) listener()
    },
  }
}

let sentinels: FakeSentinel[]
let request: ReturnType<typeof vi.fn>
let hadWakeLock: boolean
let previousWakeLock: unknown

function installWakeLock(impl?: () => Promise<unknown>) {
  request = vi.fn(
    impl ??
      (() => {
        const sentinel = makeSentinel()
        sentinels.push(sentinel)
        return Promise.resolve(sentinel)
      }),
  )
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
    writable: true,
  })
}

/**
 * A wake lock whose requests stay *pending* until the caller settles them.
 *
 * The in-flight window is the whole subject of the tests below, and with the
 * default `Promise.resolve(sentinel)` impl that window is closed by the next
 * microtask — too short for a `visibilitychange` to land inside it. Returns the
 * list of "resolve request N" callbacks, in request order.
 */
function installDeferredWakeLock(): Array<() => void> {
  const settlers: Array<() => void> = []
  installWakeLock(
    () =>
      new Promise((resolve) => {
        const sentinel = makeSentinel()
        sentinels.push(sentinel)
        settlers.push(() => {
          resolve(sentinel)
        })
      }),
  )
  return settlers
}

function showPage() {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

beforeEach(() => {
  sentinels = []
  hadWakeLock = 'wakeLock' in navigator
  previousWakeLock = (navigator as Navigator & { wakeLock?: unknown }).wakeLock
  setVisibility('visible')
})

afterEach(() => {
  if (hadWakeLock) {
    Object.defineProperty(navigator, 'wakeLock', {
      value: previousWakeLock,
      configurable: true,
      writable: true,
    })
  } else {
    Reflect.deleteProperty(navigator, 'wakeLock')
  }
  vi.restoreAllMocks()
})

describe('useScreenWakeLock', () => {
  it('takes a screen wake lock as soon as the window it guards opens', async () => {
    installWakeLock()
    const { result } = renderHook(() => useScreenWakeLock(true))

    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('takes no lock while inactive — the cost is scoped to the pairing window', async () => {
    installWakeLock()
    const { result } = renderHook(() => useScreenWakeLock(false))

    await act(async () => {
      await Promise.resolve()
    })
    expect(request).not.toHaveBeenCalled()
    expect(result.current.held).toBe(false)
  })

  it('releases the lock when the window closes', async () => {
    installWakeLock()
    const { result, rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    })
    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })

    rerender({ active: false })

    await waitFor(() => {
      expect(sentinels[0]?.release).toHaveBeenCalledTimes(1)
    })
    expect(result.current.held).toBe(false)
  })

  it('releases the lock on unmount, so a closed dialog never holds the device awake', async () => {
    installWakeLock()
    const { result, unmount } = renderHook(() => useScreenWakeLock(true))
    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })

    unmount()

    await waitFor(() => {
      expect(sentinels[0]?.release).toHaveBeenCalledTimes(1)
    })
  })

  it('re-acquires when the page becomes visible again', async () => {
    // The platform releases the lock on hide and does NOT restore it on show.
    // Without a re-acquire, one app-switch mid-pair silently removes the
    // protection — and the user would have no way to tell.
    installWakeLock()
    const { result } = renderHook(() => useScreenWakeLock(true))
    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })

    // The browser drops it while hidden.
    act(() => {
      setVisibility('hidden')
      sentinels[0]?.fireRelease()
    })
    await waitFor(() => {
      expect(result.current.held).toBe(false)
    })

    act(() => {
      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })
  })

  // -- the in-flight window ------------------------------------------------
  //
  // `sentinelRef` is only set once a request has *settled*, so it cannot stop a
  // second `acquire()` on its own. `visibilitychange` fires whenever the user
  // swipes back to the app — routinely while the first request is still
  // pending.

  it('does not fire a second request while the first is still in flight', async () => {
    const settle = installDeferredWakeLock()
    renderHook(() => useScreenWakeLock(true))

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1)
    })

    act(() => {
      showPage()
    })

    expect(request).toHaveBeenCalledTimes(1)

    await act(async () => {
      for (const resolve of settle) resolve()
      await Promise.resolve()
    })
  })

  it('leaks no sentinel when visibility flips during a pending request', async () => {
    // The harm the guard prevents, stated as the user sees it: two requests
    // both resolve, the second overwrites `sentinelRef`, and the first sentinel
    // has no owner left to release it — so the screen stays awake after the
    // pairing dialog is closed.
    const settle = installDeferredWakeLock()
    const { result, rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    })
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1)
    })

    act(() => {
      showPage()
    })
    await act(async () => {
      for (const resolve of settle) resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(result.current.held).toBe(true)
    })

    // Close the dialog: nothing may still be holding the screen awake.
    rerender({ active: false })

    await waitFor(() => {
      expect(result.current.held).toBe(false)
    })
    expect(sentinels.length).toBeGreaterThan(0)
    for (const [i, sentinel] of sentinels.entries()) {
      expect(
        sentinel.release,
        `sentinel ${i} of ${sentinels.length} was handed out and never released — the screen stays awake after the dialog closed`,
      ).toHaveBeenCalled()
    }
  })

  it('retries after a refused request — the guard must not wedge', async () => {
    // The other edge of the same guard: if the in-flight marker were cleared
    // only on success, one refusal would block every later re-acquire and a
    // returning user would silently lose the protection for the whole pair.
    installWakeLock(() => Promise.reject(new Error('NotAllowedError')))
    const { result } = renderHook(() => useScreenWakeLock(true))

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.held).toBe(false)

    act(() => {
      showPage()
    })

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2)
    })
  })

  it('reports an unsupported platform instead of throwing', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock')
    const { result } = renderHook(() => useScreenWakeLock(true))

    await waitFor(() => {
      expect(result.current.unsupported).toBe(true)
    })
    expect(result.current.held).toBe(false)
  })

  it('survives a refused request without holding a lock it does not have', async () => {
    installWakeLock(() => Promise.reject(new Error('NotAllowedError')))
    const { result } = renderHook(() => useScreenWakeLock(true))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.held).toBe(false)
    expect(result.current.unsupported).toBe(false)
  })
})
