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
import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock, makeBlockRow } from '@/__tests__/fixtures'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { useBlockReschedule } from '@/hooks/useBlockReschedule'
import { logger } from '@/lib/logger'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

const block1 = makeBlockRow({ id: 'BLOCK_1' })

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
    stubInvoke({ set_due_date: () => block1 })

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
    stubInvoke({ set_due_date: () => block1 })

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
    stubInvoke({ set_due_date: () => Promise.reject(cause) })

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
    stubInvoke({ set_scheduled_date: () => block1 })

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
    stubInvoke({ set_scheduled_date: () => block1 })

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
    stubInvoke({ set_scheduled_date: () => Promise.reject(cause) })

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
// Reschedule
// ---------------------------------------------------------------------------

/**
 * Simulate the multi-IPC `reschedule` flow: `getBlock(blockId)` then either
 * `setDueDate` or `setScheduledDate` depending on the block's current
 * shape. Each test stubs the two commands by NAME, so the branch taken is
 * read off `toHaveBeenNthCalledWith` rather than off a positional queue.
 */
describe('useBlockReschedule.reschedule', () => {
  it('writes due_date when the block has neither date set', async () => {
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', due_date: null, scheduled_date: null }),
      set_due_date: () => block1,
    })

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
    stubInvoke({
      get_block: () =>
        makeBlockRow({ id: 'BLOCK_1', due_date: null, scheduled_date: '2026-04-10' }),
      set_scheduled_date: () => block1,
    })

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
    stubInvoke({
      get_block: () =>
        makeBlockRow({ id: 'BLOCK_1', due_date: '2026-04-09', scheduled_date: '2026-04-10' }),
      set_due_date: () => block1,
    })

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
    stubInvoke({
      get_block: () => Promise.reject(lookupErr),
      set_due_date: () => block1,
    })

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
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', due_date: null, scheduled_date: null }),
      set_due_date: () => Promise.reject(setterErr),
    })

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

// ---------------------------------------------------------------------------
// Reschedule — page store patch (#5288)
// ---------------------------------------------------------------------------

/**
 * Mounts two page stores the way the weekly view does (one provider per day
 * page): `PAGE_OWNER` holds `BLOCK_1`, `PAGE_OTHER` does not.
 */
function mountPageStores(ownedRow: { due_date: string | null; scheduled_date: string | null }) {
  render(
    <>
      <PageBlockStoreProvider pageId="PAGE_OWNER">{null}</PageBlockStoreProvider>
      <PageBlockStoreProvider pageId="PAGE_OTHER">{null}</PageBlockStoreProvider>
    </>,
  )
  const owner = getPageStore('PAGE_OWNER')
  const other = getPageStore('PAGE_OTHER')
  if (!owner || !other) throw new Error('page stores not registered')
  act(() => {
    owner.setState({ blocks: [makeBlock({ id: 'BLOCK_1', page_id: 'PAGE_OWNER', ...ownedRow })] })
    other.setState({
      blocks: [makeBlock({ id: 'BLOCK_2', page_id: 'PAGE_OTHER', due_date: '2026-04-10' })],
    })
  })
  return { owner, other }
}

describe('useBlockReschedule.reschedule — page store patch', () => {
  it('writes the new due_date into the owning page store row', async () => {
    const { owner } = mountPageStores({ due_date: '2026-04-10', scheduled_date: null })
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', due_date: '2026-04-10' }),
      set_due_date: () => block1,
    })

    const { result } = renderHook(() => useBlockReschedule())
    await act(async () => {
      await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    const row = owner.getState().blocksById.get('BLOCK_1')
    expect(row?.due_date).toBe('2026-04-15')
    expect(row?.scheduled_date).toBeNull()
  })

  it('writes the new scheduled_date into the owning page store row', async () => {
    const { owner } = mountPageStores({ due_date: null, scheduled_date: '2026-04-10' })
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', scheduled_date: '2026-04-10' }),
      set_scheduled_date: () => block1,
    })

    const { result } = renderHook(() => useBlockReschedule())
    await act(async () => {
      await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    const row = owner.getState().blocksById.get('BLOCK_1')
    expect(row?.scheduled_date).toBe('2026-04-15')
    expect(row?.due_date).toBeNull()
  })

  it('leaves a page store that does not own the block untouched', async () => {
    const { other } = mountPageStores({ due_date: '2026-04-10', scheduled_date: null })
    const otherBlocksBefore = other.getState().blocks
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', due_date: '2026-04-10' }),
      set_due_date: () => block1,
    })

    const { result } = renderHook(() => useBlockReschedule())
    await act(async () => {
      await result.current.reschedule('BLOCK_1', '2026-04-15')
    })

    expect(other.getState().blocks).toBe(otherBlocksBefore)
  })

  it('leaves the owning page store row as it was when the setter rejects', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { owner } = mountPageStores({ due_date: '2026-04-10', scheduled_date: null })
    const setterErr = new Error('write failed')
    stubInvoke({
      get_block: () => makeBlockRow({ id: 'BLOCK_1', due_date: '2026-04-10' }),
      set_due_date: () => Promise.reject(setterErr),
    })

    const { result } = renderHook(() => useBlockReschedule())
    await expect(
      act(async () => {
        await result.current.reschedule('BLOCK_1', '2026-04-15')
      }),
    ).rejects.toBe(setterErr)

    expect(owner.getState().blocksById.get('BLOCK_1')?.due_date).toBe('2026-04-10')
  })
})
