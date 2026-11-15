import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logFrontend } from '@/lib/ipc-helpers'
import { logLatencySample } from '@/lib/latency-sample'
import { logger } from '@/lib/logger'
import { PREFERENCES, writePreference } from '@/lib/preferences'

vi.mock('@/lib/ipc-helpers', () => ({ logFrontend: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }))

const mockedLogFrontend = vi.mocked(logFrontend)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.spyOn(performance, 'now').mockReturnValue(130.25)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('logLatencySample', () => {
  it('logs one line with the focus and answer times when debug mode is on', () => {
    writePreference(PREFERENCES.debugMode, true)

    logLatencySample('enter-split', 100, 104.5, true)

    expect(mockedLogFrontend).toHaveBeenCalledTimes(1)
    expect(mockedLogFrontend).toHaveBeenCalledWith(
      'info',
      'latency',
      'enter-split focus_ms=4.5 answered_ms=30.3 ok=true',
    )
  })

  it('logs nothing with debug mode off', () => {
    logLatencySample('merge', 100, 104.5, false)

    expect(mockedLogFrontend).not.toHaveBeenCalled()
  })

  it('warns when the line cannot reach the backend', async () => {
    writePreference(PREFERENCES.debugMode, true)
    const error = new Error('ipc closed')
    mockedLogFrontend.mockRejectedValueOnce(error)

    logLatencySample('merge', 100, 104.5, false)

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'latency',
        'latency sample not logged',
        { action: 'merge' },
        error,
      )
    })
  })
})
