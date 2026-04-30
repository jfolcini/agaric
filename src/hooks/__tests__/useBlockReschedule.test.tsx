/**
 * Tests for useBlockReschedule hook — typed wrappers around setDueDate /
 * setScheduledDate IPCs.
 *
 * Validates:
 * - setDueDate calls the underlying IPC with the right args and propagates the result
 * - setDueDate logs a warning and re-throws when the IPC rejects
 * - setScheduledDate calls the underlying IPC with the right args
 * - setScheduledDate logs a warning and re-throws when the IPC rejects
 * - clearing (date=null) is forwarded to the IPC unchanged
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import { useBlockReschedule } from '../useBlockReschedule'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// setDueDate
// ---------------------------------------------------------------------------

describe('useBlockReschedule.setDueDate', () => {
  it('invokes set_due_date with the expected args (string date)', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    await act(async () => {
      await result.current.setDueDate('BLOCK_1', '2026-04-15')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('forwards null to clear the due date', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    await act(async () => {
      await result.current.setDueDate('BLOCK_1', null)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_due_date', {
      blockId: 'BLOCK_1',
      date: null,
    })
  })

  it('logs a structured warning and re-throws when the IPC rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const cause = new Error('IPC failed')
    mockedInvoke.mockRejectedValueOnce(cause)

    const { result } = renderHook(() => useBlockReschedule())

    await expect(
      act(async () => {
        await result.current.setDueDate('BLOCK_1', '2026-04-15')
      }),
    ).rejects.toBe(cause)

    expect(warnSpy).toHaveBeenCalledWith(
      'useBlockReschedule',
      'setDueDate failed',
      { blockId: 'BLOCK_1', date: '2026-04-15' },
      cause,
    )
  })
})

// ---------------------------------------------------------------------------
// setScheduledDate
// ---------------------------------------------------------------------------

describe('useBlockReschedule.setScheduledDate', () => {
  it('invokes set_scheduled_date with the expected args (string date)', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    await act(async () => {
      await result.current.setScheduledDate('BLOCK_1', '2026-04-15')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('forwards null to clear the scheduled date', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    await act(async () => {
      await result.current.setScheduledDate('BLOCK_1', null)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('set_scheduled_date', {
      blockId: 'BLOCK_1',
      date: null,
    })
  })

  it('logs a structured warning and re-throws when the IPC rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const cause = new Error('disk full')
    mockedInvoke.mockRejectedValueOnce(cause)

    const { result } = renderHook(() => useBlockReschedule())

    await expect(
      act(async () => {
        await result.current.setScheduledDate('BLOCK_1', '2026-04-15')
      }),
    ).rejects.toBe(cause)

    expect(warnSpy).toHaveBeenCalledWith(
      'useBlockReschedule',
      'setScheduledDate failed',
      { blockId: 'BLOCK_1', date: '2026-04-15' },
      cause,
    )
  })
})
