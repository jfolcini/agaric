/**
 * Tests for useIpcCommand — MAINT-120 hook that collapses the
 * try/catch + logger + optimistic/revert pattern shared by the settings
 * and dialog components.
 *
 * Validates:
 *  - Happy path: `call` resolves → returns the value, no logger fired,
 *    no `onError`, loading false at end.
 *  - Error path: `call` rejects → revert called, `logger.error` called
 *    with module + message + ctx, `onError` called, returns `undefined`,
 *    loading false at end.
 *  - Optimistic: `optimistic` fires BEFORE `call`; `revert` fires on
 *    rejection.
 *  - Concurrent executes: state transitions correctly — `loading`
 *    only flips to `false` when the most recent execute settles.
 *  - logLevel='warn': uses `logger.warn` instead of `logger.error`.
 *  - errorLogContext function form: receives the execute args.
 *  - onSuccess callback fires with the result.
 *  - onSuccess errors do NOT trigger revert/onError (review-MAINT-120).
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { useIpcCommand } from '../useIpcCommand'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedLoggerError = vi.mocked(logger.error)
const mockedLoggerWarn = vi.mocked(logger.warn)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useIpcCommand — happy path', () => {
  it('returns the resolved value, no logger, no error', async () => {
    const call = vi.fn(async (args: { id: string }) => ({ ok: true, id: args.id }))
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useIpcCommand({
        call,
        module: 'TestModule',
        errorLogMessage: 'should never fire',
        onSuccess,
        onError,
      }),
    )

    let value: { ok: boolean; id: string } | undefined
    await act(async () => {
      value = await result.current.execute({ id: 'A1' })
    })

    expect(value).toEqual({ ok: true, id: 'A1' })
    expect(call).toHaveBeenCalledWith({ id: 'A1' })
    expect(onSuccess).toHaveBeenCalledWith({ ok: true, id: 'A1' }, { id: 'A1' })
    expect(onError).not.toHaveBeenCalled()
    expect(mockedLoggerError).not.toHaveBeenCalled()
    expect(mockedLoggerWarn).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('flips loading to true while the call is in flight and back to false on resolve', async () => {
    let resolveCall: ((value: string) => void) | null = null
    const call = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCall = resolve
        }),
    )
    const { result } = renderHook(() =>
      useIpcCommand<void, string>({
        call,
        module: 'TestModule',
        errorLogMessage: 'unused',
      }),
    )

    expect(result.current.loading).toBe(false)

    let promise: Promise<string | undefined>
    act(() => {
      promise = result.current.execute()
    })

    // Loading flipped on synchronously inside the act() above.
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveCall?.('done')
      await promise
    })

    expect(result.current.loading).toBe(false)
  })
})

describe('useIpcCommand — error path', () => {
  it('logs via logger.error, calls revert and onError, returns undefined', async () => {
    const boom = new Error('backend exploded')
    const call = vi.fn(async (_args: { mode: 'on' | 'off' }) => {
      throw boom
    })
    const revert = vi.fn()
    const onError = vi.fn()

    const { result } = renderHook(() =>
      useIpcCommand({
        call,
        module: 'TestModule',
        errorLogMessage: 'failed to set mode',
        errorLogContext: { source: 'unit-test' },
        revert,
        onError,
      }),
    )

    let value: unknown
    await act(async () => {
      value = await result.current.execute({ mode: 'on' })
    })

    expect(value).toBeUndefined()
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'TestModule',
      'failed to set mode',
      { source: 'unit-test' },
      boom,
    )
    expect(revert).toHaveBeenCalledWith({ mode: 'on' }, boom)
    expect(onError).toHaveBeenCalledWith(boom, { mode: 'on' })
    expect(result.current.loading).toBe(false)
  })

  it('passes non-Error rejections through to onError verbatim', async () => {
    const onError = vi.fn()
    const call = vi.fn(async () => {
      // biome-ignore lint/style/useThrowOnlyError: non-Error rejection is the case under test
      throw 'plain string'
    })
    const { result } = renderHook(() =>
      useIpcCommand<void, void>({
        call,
        module: 'TestModule',
        errorLogMessage: 'plain string rejection',
        onError,
      }),
    )

    await act(async () => {
      await result.current.execute()
    })

    expect(onError).toHaveBeenCalledWith('plain string', undefined)
  })

  it('runs revert BEFORE onError', async () => {
    const order: string[] = []
    const call = vi.fn(async () => {
      throw new Error('x')
    })
    const revert = vi.fn(() => {
      order.push('revert')
    })
    const onError = vi.fn(() => {
      order.push('onError')
    })

    const { result } = renderHook(() =>
      useIpcCommand<void, void>({
        call,
        module: 'TestModule',
        errorLogMessage: 'order test',
        revert,
        onError,
      }),
    )

    await act(async () => {
      await result.current.execute()
    })

    expect(order).toEqual(['revert', 'onError'])
  })

  it('does NOT trigger revert/onError when onSuccess throws (review-MAINT-120)', async () => {
    // A successful IPC followed by a failing onSuccess callback (e.g.
    // toast library throws, refetch fails) is NOT the same as a failed
    // IPC. The backend already saw the mutation succeed; reverting the
    // optimistic update would diverge UI from server state. The hook
    // catches the onSuccess error, warn-logs it, and returns the result.
    const optimistic = vi.fn()
    const revert = vi.fn()
    const onError = vi.fn()
    const successError = new Error('toast library exploded')
    const onSuccess = vi.fn(() => {
      throw successError
    })
    const call = vi.fn(async () => 'backend-ok')

    const { result } = renderHook(() =>
      useIpcCommand<void, string>({
        call,
        module: 'TestModule',
        errorLogMessage: 'should not fire',
        optimistic,
        revert,
        onSuccess,
        onError,
      }),
    )

    let value: string | undefined
    await act(async () => {
      value = await result.current.execute()
    })

    // The IPC result is still returned — caller-visible behavior is success.
    expect(value).toBe('backend-ok')
    // Optimistic ran (we never undo it).
    expect(optimistic).toHaveBeenCalledTimes(1)
    // CRUCIAL: revert + onError are NOT called.
    expect(revert).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    // The onSuccess error is logged at WARN, not ERROR (the IPC didn't fail).
    expect(mockedLoggerError).not.toHaveBeenCalled()
    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      'TestModule',
      'onSuccess callback threw',
      undefined,
      successError,
    )
    expect(result.current.loading).toBe(false)
  })
})

describe('useIpcCommand — optimistic + revert', () => {
  it('fires optimistic BEFORE call', async () => {
    const order: string[] = []
    const call = vi.fn(async () => {
      order.push('call')
      return 'done'
    })
    const optimistic = vi.fn(() => {
      order.push('optimistic')
    })

    const { result } = renderHook(() =>
      useIpcCommand<void, string>({
        call,
        module: 'TestModule',
        errorLogMessage: 'unused',
        optimistic,
      }),
    )

    await act(async () => {
      await result.current.execute()
    })

    expect(order).toEqual(['optimistic', 'call'])
    expect(optimistic).toHaveBeenCalledWith(undefined)
  })

  it('fires optimistic, then revert on rejection (with the args + err)', async () => {
    const boom = new Error('toggle rejected')
    const call = vi.fn(async () => {
      throw boom
    })
    const optimistic = vi.fn()
    const revert = vi.fn()

    const { result } = renderHook(() =>
      useIpcCommand({
        call,
        module: 'TestModule',
        errorLogMessage: 'optimistic toggle failed',
        optimistic,
        revert,
      }),
    )

    await act(async () => {
      await result.current.execute({ enabled: true })
    })

    expect(optimistic).toHaveBeenCalledWith({ enabled: true })
    expect(revert).toHaveBeenCalledWith({ enabled: true }, boom)
  })
})

describe('useIpcCommand — concurrent executes', () => {
  it('only the most recent execute clears loading on settle', async () => {
    const resolvers: Array<(value: number) => void> = []
    const call = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const { result } = renderHook(() =>
      useIpcCommand<void, number>({
        call,
        module: 'TestModule',
        errorLogMessage: 'unused',
      }),
    )

    // Start two concurrent executes.
    let firstPromise: Promise<number | undefined>
    let secondPromise: Promise<number | undefined>
    act(() => {
      firstPromise = result.current.execute()
      secondPromise = result.current.execute()
    })

    expect(result.current.loading).toBe(true)

    // Resolve the FIRST call: loading must stay true (the second is still pending).
    await act(async () => {
      resolvers[0]?.(1)
      await firstPromise
    })
    expect(result.current.loading).toBe(true)

    // Resolve the second call: loading flips to false now.
    await act(async () => {
      resolvers[1]?.(2)
      await secondPromise
    })
    expect(result.current.loading).toBe(false)
  })
})

describe('useIpcCommand — log level', () => {
  it('uses logger.warn when logLevel is "warn"', async () => {
    const boom = new Error('warn-only')
    const call = vi.fn(async () => {
      throw boom
    })
    const { result } = renderHook(() =>
      useIpcCommand<void, void>({
        call,
        module: 'TestModule',
        errorLogMessage: 'warn-level failure',
        logLevel: 'warn',
      }),
    )

    await act(async () => {
      await result.current.execute()
    })

    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      'TestModule',
      'warn-level failure',
      undefined,
      boom,
    )
    expect(mockedLoggerError).not.toHaveBeenCalled()
  })
})

describe('useIpcCommand — errorLogContext', () => {
  it('passes the function-form context through with the execute args', async () => {
    const boom = new Error('contextful')
    const call = vi.fn(async (_args: { n: number }) => {
      throw boom
    })

    const { result } = renderHook(() =>
      useIpcCommand({
        call,
        module: 'TestModule',
        errorLogMessage: 'with ctx',
        errorLogContext: (args) => ({ n: args.n }),
      }),
    )

    await act(async () => {
      await result.current.execute({ n: 42 })
    })

    expect(mockedLoggerError).toHaveBeenCalledWith('TestModule', 'with ctx', { n: 42 }, boom)
  })
})
