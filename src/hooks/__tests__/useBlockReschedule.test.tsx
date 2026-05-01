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

// ---------------------------------------------------------------------------
// reschedule (MAINT-131)
// ---------------------------------------------------------------------------

/**
 * Simulate the multi-IPC `reschedule` flow: `getBlock(blockId)` then either
 * `setDueDate` or `setScheduledDate` depending on the block's current
 * shape. Each test queues the IPC responses in order via
 * `mockedInvoke.mockResolvedValueOnce` / `mockRejectedValueOnce`.
 */
describe('useBlockReschedule.reschedule', () => {
  it('writes due_date when the block has neither date set', async () => {
    mockedInvoke
      .mockResolvedValueOnce({ id: 'BLOCK_1', due_date: null, scheduled_date: null })
      .mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    let outcome: { field: 'due_date' | 'scheduled_date' } | undefined
    await act(async () => {
      outcome = await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    expect(outcome).toEqual({ field: 'due_date' })
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'get_block', { blockId: 'BLOCK_1' })
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'set_due_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('writes scheduled_date when the block has scheduled_date set and due_date null', async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        id: 'BLOCK_1',
        due_date: null,
        scheduled_date: '2026-04-10',
      })
      .mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    let outcome: { field: 'due_date' | 'scheduled_date' } | undefined
    await act(async () => {
      outcome = await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    expect(outcome).toEqual({ field: 'scheduled_date' })
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'set_scheduled_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('prefers due_date when both fields are set on the block', async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        id: 'BLOCK_1',
        due_date: '2026-04-09',
        scheduled_date: '2026-04-10',
      })
      .mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    let outcome: { field: 'due_date' | 'scheduled_date' } | undefined
    await act(async () => {
      outcome = await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    expect(outcome).toEqual({ field: 'due_date' })
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'set_due_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('falls back to setDueDate and logs a warning when getBlock rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const lookupErr = new Error('getBlock failed')
    mockedInvoke.mockRejectedValueOnce(lookupErr).mockResolvedValueOnce({ id: 'BLOCK_1' })

    const { result } = renderHook(() => useBlockReschedule())

    let outcome: { field: 'due_date' | 'scheduled_date' } | undefined
    await act(async () => {
      outcome = await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    expect(outcome).toEqual({ field: 'due_date' })
    expect(warnSpy).toHaveBeenCalledWith(
      'useBlockReschedule',
      'reschedule getBlock lookup failed; falling back to setDueDate',
      { blockId: 'BLOCK_1' },
      lookupErr,
    )
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'set_due_date', {
      blockId: 'BLOCK_1',
      date: '2026-04-15',
    })
  })

  it('re-throws when the underlying setter rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const setterErr = new Error('write failed')
    mockedInvoke
      .mockResolvedValueOnce({ id: 'BLOCK_1', due_date: null, scheduled_date: null })
      .mockRejectedValueOnce(setterErr)

    const { result } = renderHook(() => useBlockReschedule())

    await expect(
      act(async () => {
        await result.current.reschedule('BLOCK_1', '2026-04-15')
      }),
    ).rejects.toBe(setterErr)

    // The setDueDate inner wrapper logs its own warn before re-throwing
    expect(warnSpy).toHaveBeenCalledWith(
      'useBlockReschedule',
      'setDueDate failed',
      { blockId: 'BLOCK_1', date: '2026-04-15' },
      setterErr,
    )
  })
})
