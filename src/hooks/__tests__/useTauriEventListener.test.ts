/**
 * Tests for `useTauriEventListener` — MAINT-122.
 *
 * Validates:
 *   - registers the listener with the requested event name,
 *   - dispatches resolved unlisten on unmount,
 *   - calls unlisten directly when the component unmounts before
 *     `listen()` resolves (the cancelled-flag race),
 *   - default error path logs via `logger.warn`,
 *   - custom `onError` overrides the default error path,
 *   - `enabled = false` is a full no-op (no listen, no cleanup).
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUnlisten, mockListen, mockLoggerWarn } = vi.hoisted(() => {
  const mockUnlisten = vi.fn()
  const mockListen = vi.fn().mockResolvedValue(mockUnlisten)
  const mockLoggerWarn = vi.fn()
  return { mockUnlisten, mockListen, mockLoggerWarn }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}))

import { useTauriEventListener } from '../useTauriEventListener'

beforeEach(() => {
  vi.clearAllMocks()
  mockListen.mockResolvedValue(mockUnlisten)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useTauriEventListener', () => {
  it('registers a listener with the given event name', async () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler))

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))
    expect(mockListen).toHaveBeenCalledWith('test:event', expect.any(Function))

    unmount()
  })

  it('forwards events from listen() to the handler', async () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler))

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    const registered = mockListen.mock.calls[0]?.[1] as (e: { payload: unknown }) => void
    registered({ payload: { foo: 'bar' } })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ payload: { foo: 'bar' } })

    unmount()
  })

  it('calls unlisten on unmount when listen has already resolved', async () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler))

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))
    // Drain the .then() so `unlisten` is captured by the closure.
    await Promise.resolve()

    unmount()

    expect(mockUnlisten).toHaveBeenCalledTimes(1)
  })

  it('calls unlisten directly when component unmounts before listen() resolves', async () => {
    // Build a promise we can resolve manually after unmount.
    let resolveListen: (fn: () => void) => void = () => {}
    mockListen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve
        }),
    )

    const handler = vi.fn()
    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler))

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    // Unmount BEFORE listen() resolves.
    unmount()

    // Now resolve listen — the cancelled-flag branch must invoke the
    // unlisten function directly.
    const lateUnlisten = vi.fn()
    resolveListen(lateUnlisten)
    await Promise.resolve()
    await Promise.resolve()

    expect(lateUnlisten).toHaveBeenCalledTimes(1)
    // The original `mockUnlisten` was never resolved through, so it
    // should NOT have been called.
    expect(mockUnlisten).not.toHaveBeenCalled()
  })

  it('logs via logger.warn on listen() rejection (default error path)', async () => {
    mockListen.mockRejectedValueOnce(new Error('IPC unavailable'))

    const handler = vi.fn()
    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler))

    await vi.waitFor(() => expect(mockLoggerWarn).toHaveBeenCalledTimes(1))
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'useTauriEventListener',
      'Failed to listen to test:event',
      undefined,
      expect.any(Error),
    )

    unmount()
  })

  it('invokes custom onError on listen() rejection (overrides default)', async () => {
    mockListen.mockRejectedValueOnce(new Error('boom'))
    const onError = vi.fn()
    const handler = vi.fn()

    const { unmount } = renderHook(() => useTauriEventListener('test:event', handler, { onError }))

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    // Default warn must not fire when onError is provided.
    expect(mockLoggerWarn).not.toHaveBeenCalled()

    unmount()
  })

  it('is a full no-op when enabled is false', async () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() =>
      useTauriEventListener('test:event', handler, { enabled: false }),
    )

    // Flush microtasks — no listen call should have been issued.
    await Promise.resolve()
    await Promise.resolve()

    expect(mockListen).not.toHaveBeenCalled()

    unmount()

    expect(mockUnlisten).not.toHaveBeenCalled()
  })

  it('does not re-register the listener when handler reference changes', async () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ h }: { h: (event: { payload: unknown }) => void }) =>
        useTauriEventListener('test:event', h),
      { initialProps: { h: handler1 } },
    )

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    // Re-render with a new handler reference. The hook must keep using
    // the original listener registration (no second listen() call).
    rerender({ h: handler2 })
    await Promise.resolve()

    expect(mockListen).toHaveBeenCalledTimes(1)

    // Dispatch an event — the LATEST handler should receive it.
    const registered = mockListen.mock.calls[0]?.[1] as (e: { payload: unknown }) => void
    registered({ payload: 'x' })

    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalledTimes(1)

    unmount()
  })
})
