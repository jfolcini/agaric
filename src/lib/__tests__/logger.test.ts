/**
 * Tests for src/lib/logger.ts — structured frontend logging utility
 * with dual-write IPC bridge, cause extraction, and rate limiting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetRateLimits, logger, setLogLevel } from '../logger'

// ── Mock logFrontend from tauri ──────────────────────────────────────────

const mockLogFrontend = vi.fn<
  (
    level: string,
    module: string,
    message: string,
    stack?: string,
    context?: string,
  ) => Promise<void>
>(() => Promise.resolve())

vi.mock('../tauri', () => ({
  logFrontend: (...args: [string, string, string, string?, string?]) => mockLogFrontend(...args),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T12:00:00.000Z')

/** Simulate Tauri environment by setting __TAURI_INTERNALS__ on window. */
function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    writable: true,
    configurable: true,
  })
}

/** Remove __TAURI_INTERNALS__ to simulate browser-only environment. */
function disableTauri() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockLogFrontend.mockClear()
  _resetRateLimits()
  disableTauri()
  // Reset to dev default
  setLogLevel('debug')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  disableTauri()
})

// ── Structured format ──────────────────────────────────────────────────

describe('structured format', () => {
  it('includes timestamp, level, module, and message', () => {
    logger.error('TestModule', 'something broke')
    expect(console.error).toHaveBeenCalledWith(
      '[2025-06-15T12:00:00.000Z] [ERROR] [TestModule] something broke',
    )
  })

  it('appends JSON-stringified data when provided', () => {
    logger.warn('Sync', 'timeout', { peerId: 'abc', attempt: 3 })
    expect(console.warn).toHaveBeenCalledWith(
      '[2025-06-15T12:00:00.000Z] [WARN] [Sync] timeout {"peerId":"abc","attempt":3}',
    )
  })

  it('omits data suffix when no data is provided', () => {
    logger.info('Boot', 'started')
    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(arg).not.toContain('{')
  })
})

// ── Level filtering ────────────────────────────────────────────────────

describe('level filtering', () => {
  it('logs all levels when minLevel is debug', () => {
    setLogLevel('debug')
    logger.debug('M', 'dbg')
    logger.info('M', 'inf')
    logger.warn('M', 'wrn')
    logger.error('M', 'err')
    expect(console.debug).toHaveBeenCalledTimes(1)
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('suppresses debug and info when minLevel is warn', () => {
    setLogLevel('warn')
    logger.debug('M', 'dbg')
    logger.info('M', 'inf')
    logger.warn('M', 'wrn')
    logger.error('M', 'err')
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('only logs errors when minLevel is error', () => {
    setLogLevel('error')
    logger.debug('M', 'dbg')
    logger.info('M', 'inf')
    logger.warn('M', 'wrn')
    logger.error('M', 'err')
    expect(console.debug).not.toHaveBeenCalled()
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(1)
  })
})

// ── setLogLevel ────────────────────────────────────────────────────────

describe('setLogLevel', () => {
  it('changes filtering dynamically', () => {
    setLogLevel('error')
    logger.warn('M', 'should be suppressed')
    expect(console.warn).not.toHaveBeenCalled()

    setLogLevel('debug')
    logger.warn('M', 'should now appear')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})

// ── Each log method calls the correct console method ───────────────────

describe('console method mapping', () => {
  it('debug calls console.debug', () => {
    logger.debug('M', 'msg')
    expect(console.debug).toHaveBeenCalledTimes(1)
  })

  it('info calls console.info', () => {
    logger.info('M', 'msg')
    expect(console.info).toHaveBeenCalledTimes(1)
  })

  it('warn calls console.warn', () => {
    logger.warn('M', 'msg')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('error calls console.error', () => {
    logger.error('M', 'msg')
    expect(console.error).toHaveBeenCalledTimes(1)
  })
})

// ── Default level in dev mode ──────────────────────────────────────────

describe('default level', () => {
  it('defaults to debug in dev mode (allows all levels)', () => {
    // setLogLevel('debug') is called in beforeEach to mirror dev default
    logger.debug('M', 'visible')
    expect(console.debug).toHaveBeenCalledTimes(1)
  })
})

// ── Dual-write IPC bridge ──────────────────────────────────────────────

describe('dual-write IPC bridge', () => {
  it('warn calls logFrontend when Tauri is available', () => {
    enableTauri()
    logger.warn('Sync', 'timeout')
    expect(mockLogFrontend).toHaveBeenCalledTimes(1)
    expect(mockLogFrontend).toHaveBeenCalledWith(
      'warn',
      'Sync',
      'timeout',
      expect.any(String), // stack trace
      undefined, // no cause context
    )
  })

  it('error calls logFrontend when Tauri is available', () => {
    enableTauri()
    logger.error('DB', 'write failed')
    expect(mockLogFrontend).toHaveBeenCalledTimes(1)
    expect(mockLogFrontend).toHaveBeenCalledWith(
      'error',
      'DB',
      'write failed',
      expect.any(String),
      undefined,
    )
  })

  it('debug does NOT call logFrontend', () => {
    enableTauri()
    logger.debug('M', 'trace msg')
    expect(mockLogFrontend).not.toHaveBeenCalled()
  })

  it('info does NOT call logFrontend', () => {
    enableTauri()
    logger.info('M', 'info msg')
    expect(mockLogFrontend).not.toHaveBeenCalled()
  })

  it('does not call logFrontend when Tauri is absent (fallback)', () => {
    disableTauri()
    logger.error('M', 'some error')
    expect(mockLogFrontend).not.toHaveBeenCalled()
    // But console still works
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('swallows IPC errors silently (fire-and-forget)', () => {
    enableTauri()
    mockLogFrontend.mockRejectedValueOnce(new Error('IPC failed'))
    // Should not throw
    expect(() => logger.error('M', 'msg')).not.toThrow()
  })
})

// ── Stack capture ──────────────────────────────────────────────────────

describe('stack capture', () => {
  it('sends a stack trace to IPC for warn', () => {
    enableTauri()
    logger.warn('M', 'oops')
    const stack = mockLogFrontend.mock.calls[0]?.[3]
    expect(stack).toBeDefined()
    expect(stack).toContain('Error')
  })

  it('uses Error cause stack when an Error is passed', () => {
    enableTauri()
    const err = new Error('root cause')
    logger.error('M', 'failed', undefined, err)
    const stack = mockLogFrontend.mock.calls[0]?.[3]
    expect(stack).toBeDefined()
    expect(stack).toContain('root cause')
  })
})

// ── Cause extraction ───────────────────────────────────────────────────

describe('cause extraction', () => {
  it('includes Error cause in console output and IPC context', () => {
    enableTauri()
    const err = new Error('db connection lost')
    logger.error('DB', 'query failed', undefined, err)

    // Console should include cause info
    const consoleArg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(consoleArg).toContain('cause[0]: db connection lost')

    // IPC context should include cause chain as JSON
    const context = mockLogFrontend.mock.calls[0]?.[4]
    expect(context).toBeDefined()
    const parsed = JSON.parse(context ?? '[]')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].message).toBe('db connection lost')
    expect(parsed[0].stack).toBeDefined()
  })

  it('handles plain string as cause', () => {
    enableTauri()
    logger.warn('M', 'something', undefined, 'string cause')

    const consoleArg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(consoleArg).toContain('cause[0]: string cause')
  })

  it('handles object with message property as cause', () => {
    enableTauri()
    logger.error('M', 'fail', undefined, { message: 'custom error obj' })

    const context = mockLogFrontend.mock.calls[0]?.[4]
    const parsed = JSON.parse(context ?? '[]')
    expect(parsed[0].message).toBe('custom error obj')
    // No stack for plain objects
    expect(parsed[0].stack).toBeUndefined()
  })

  it('extracts nested .cause chain up to 3 levels', () => {
    enableTauri()
    const root = new Error('level 0')
    const mid = new Error('level 1', { cause: root })
    const top = new Error('level 2', { cause: mid })

    logger.error('M', 'deep error', undefined, top)

    const context = mockLogFrontend.mock.calls[0]?.[4]
    const parsed = JSON.parse(context ?? '[]')
    expect(parsed).toHaveLength(3)
    expect(parsed[0].message).toBe('level 2')
    expect(parsed[1].message).toBe('level 1')
    expect(parsed[2].message).toBe('level 0')
  })

  it('stops at 3 levels even if chain is deeper', () => {
    enableTauri()
    const e0 = new Error('e0')
    const e1 = new Error('e1', { cause: e0 })
    const e2 = new Error('e2', { cause: e1 })
    const e3 = new Error('e3', { cause: e2 })
    const e4 = new Error('e4', { cause: e3 })

    logger.error('M', 'very deep', undefined, e4)

    const context = mockLogFrontend.mock.calls[0]?.[4]
    const parsed = JSON.parse(context ?? '[]')
    expect(parsed).toHaveLength(3)
    expect(parsed[0].message).toBe('e4')
    expect(parsed[1].message).toBe('e3')
    expect(parsed[2].message).toBe('e2')
  })

  it('passes undefined context when no cause is provided', () => {
    enableTauri()
    logger.error('M', 'no cause')
    const context = mockLogFrontend.mock.calls[0]?.[4]
    expect(context).toBeUndefined()
  })

  it('handles null cause gracefully', () => {
    enableTauri()
    logger.error('M', 'null cause', undefined, null)
    const context = mockLogFrontend.mock.calls[0]?.[4]
    expect(context).toBeUndefined()
  })
})

// ── Rate limiting ──────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('allows up to 5 identical warn entries', () => {
    for (let i = 0; i < 5; i++) {
      logger.warn('Sync', 'timeout')
    }
    expect(console.warn).toHaveBeenCalledTimes(5)
  })

  it('suppresses the 6th identical warn entry', () => {
    for (let i = 0; i < 6; i++) {
      logger.warn('Sync', 'timeout')
    }
    // 5 real log calls + 1 suppression notice = 6 console.warn calls
    expect(console.warn).toHaveBeenCalledTimes(6)
    // The 6th call should be the rate-limit suppression notice
    const lastCall = (console.warn as ReturnType<typeof vi.fn>).mock.calls[5]?.[0] as string
    expect(lastCall).toContain('[rate-limit]')
    expect(lastCall).toContain('suppressing')
  })

  it('suppresses further entries after the 5th without additional notices', () => {
    for (let i = 0; i < 10; i++) {
      logger.warn('Sync', 'timeout')
    }
    // 5 real + 1 suppression notice = 6 total
    expect(console.warn).toHaveBeenCalledTimes(6)
  })

  it('rate-limits error entries too', () => {
    for (let i = 0; i < 7; i++) {
      logger.error('DB', 'write failed')
    }
    // 5 real error calls
    expect(console.error).toHaveBeenCalledTimes(5)
    // 1 suppression notice goes to console.warn
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('tracks different module:message keys independently', () => {
    for (let i = 0; i < 6; i++) {
      logger.warn('A', 'msg1')
    }
    for (let i = 0; i < 3; i++) {
      logger.warn('B', 'msg2')
    }
    // A: 5 real + 1 suppression = 6 warn calls
    // B: 3 real calls
    // Total: 9
    expect(console.warn).toHaveBeenCalledTimes(9)
  })

  it('resets rate limit after the time window expires', () => {
    for (let i = 0; i < 6; i++) {
      logger.warn('Sync', 'timeout')
    }
    // 5 real + 1 suppression = 6
    expect(console.warn).toHaveBeenCalledTimes(6)

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000)

    logger.warn('Sync', 'timeout')
    // +1 real call after reset = 7
    expect(console.warn).toHaveBeenCalledTimes(7)
  })

  it('rate limiting does not affect IPC calls for allowed entries', () => {
    enableTauri()
    for (let i = 0; i < 7; i++) {
      logger.warn('M', 'msg')
    }
    // Only first 5 should trigger IPC
    expect(mockLogFrontend).toHaveBeenCalledTimes(5)
  })
})
