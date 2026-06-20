/**
 * Tests for useQuickCaptureShortcut (#754).
 *
 * The hook owns the quick-capture chord: lazy-init from
 * localStorage, storage-event rebinds, and — the #754 fix — a sequenced
 * register/unregister IPC chain so StrictMode / HMR mount cycles can't
 * interleave the async calls and leave the chord dead.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@/lib/logger'
import { QUICK_CAPTURE_SHORTCUT_STORAGE_KEY } from '@/lib/quick-capture-shortcut'
import { registerGlobalShortcut, unregisterGlobalShortcut } from '@/lib/tauri'

import { useQuickCaptureShortcut } from '../useQuickCaptureShortcut'

vi.mock('@/lib/tauri', () => ({
  registerGlobalShortcut: vi.fn(),
  unregisterGlobalShortcut: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedRegister = vi.mocked(registerGlobalShortcut)
const mockedUnregister = vi.mocked(unregisterGlobalShortcut)
const mockedLogger = vi.mocked(logger)

// jsdom is not macOS, so the platform default chord is the Linux/Windows one.
const DEFAULT_CHORD = 'Ctrl+Alt+N'

/** Flush the microtask queue so chained promise links run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockedRegister.mockResolvedValue(undefined)
  mockedUnregister.mockResolvedValue(undefined)
})

describe('useQuickCaptureShortcut', () => {
  it('registers the platform-default chord on mount', async () => {
    const setOpen = vi.fn()
    renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    expect(mockedRegister).toHaveBeenCalledWith(DEFAULT_CHORD, expect.any(Function))
  })

  it('registers a user-configured chord from localStorage', async () => {
    localStorage.setItem(QUICK_CAPTURE_SHORTCUT_STORAGE_KEY, 'Ctrl+Alt+Q')
    const setOpen = vi.fn()
    renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    expect(mockedRegister).toHaveBeenCalledWith('Ctrl+Alt+Q', expect.any(Function))
  })

  it('sequences unregister AFTER an in-flight register resolves (#754 race)', async () => {
    let resolveRegister!: () => void
    mockedRegister.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRegister = resolve
        }),
    )
    const setOpen = vi.fn()
    const { unmount } = renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()
    expect(mockedRegister).toHaveBeenCalledTimes(1)

    unmount()
    await flush()
    // The register IPC is still in flight — the unregister must wait on
    // the chain, not race the backend.
    expect(mockedUnregister).not.toHaveBeenCalled()

    resolveRegister()
    await flush()
    expect(mockedUnregister).toHaveBeenCalledWith(DEFAULT_CHORD)
  })

  it('rebinds on a storage event: unregister old chord, then register new', async () => {
    const setOpen = vi.fn()
    renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()
    expect(mockedRegister).toHaveBeenCalledWith(DEFAULT_CHORD, expect.any(Function))

    localStorage.setItem(QUICK_CAPTURE_SHORTCUT_STORAGE_KEY, 'Ctrl+Alt+J')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: QUICK_CAPTURE_SHORTCUT_STORAGE_KEY }))
    })
    await flush()

    expect(mockedUnregister).toHaveBeenCalledWith(DEFAULT_CHORD)
    expect(mockedRegister).toHaveBeenLastCalledWith('Ctrl+Alt+J', expect.any(Function))
    // Strict order: the old chord is unregistered before the new register.
    const unregisterOrder = mockedUnregister.mock.invocationCallOrder[0]
    const secondRegisterOrder = mockedRegister.mock.invocationCallOrder[1]
    expect(unregisterOrder).toBeDefined()
    expect(secondRegisterOrder).toBeDefined()
    expect(unregisterOrder as number).toBeLessThan(secondRegisterOrder as number)
  })

  it('ignores storage events for other keys', async () => {
    const setOpen = vi.fn()
    renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key' }))
    })
    await flush()

    expect(mockedRegister).toHaveBeenCalledTimes(1)
    expect(mockedUnregister).not.toHaveBeenCalled()
  })

  it('opens the quick-capture dialog when the registered handler fires', async () => {
    const setOpen = vi.fn()
    renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    const [, handler] = mockedRegister.mock.calls[0] ?? []
    expect(handler).toBeTypeOf('function')
    act(() => {
      ;(handler as () => void)()
    })

    expect(setOpen).toHaveBeenCalledWith(true)
  })

  it('does NOT open the dialog when the handler fires after unmount', async () => {
    const setOpen = vi.fn()
    const { unmount } = renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()
    const [, handler] = mockedRegister.mock.calls[0] ?? []

    unmount()
    await flush()
    act(() => {
      ;(handler as () => void)()
    })

    expect(setOpen).not.toHaveBeenCalled()
  })

  it('logs a registration failure and keeps the chain alive for cleanup', async () => {
    mockedRegister.mockRejectedValueOnce(new Error('chord taken'))
    const setOpen = vi.fn()
    const { unmount } = renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'App',
      'failed to register quick-capture global shortcut',
      { accelerator: DEFAULT_CHORD },
      expect.any(Error),
    )

    // A failed register must not poison the chain — cleanup still
    // unregisters (best-effort) in order.
    unmount()
    await flush()
    expect(mockedUnregister).toHaveBeenCalledWith(DEFAULT_CHORD)
  })

  it('logs an unregister failure without throwing', async () => {
    mockedUnregister.mockRejectedValueOnce(new Error('not registered'))
    const setOpen = vi.fn()
    const { unmount } = renderHook(() => useQuickCaptureShortcut(setOpen))
    await flush()

    unmount()
    await flush()

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'App',
      'failed to unregister quick-capture global shortcut',
      { accelerator: DEFAULT_CHORD },
      expect.any(Error),
    )
  })
})
