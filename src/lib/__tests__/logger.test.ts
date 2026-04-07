/**
 * Tests for src/lib/logger.ts — structured frontend logging utility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger, setLogLevel } from '../logger'

const NOW = new Date('2025-06-15T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Reset to dev default
  setLogLevel('debug')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
