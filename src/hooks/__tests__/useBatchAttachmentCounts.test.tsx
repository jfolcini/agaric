/**
 * Tests for useBatchAttachmentCounts / BatchAttachmentCountsProvider.
 *
 * Validates:
 *  - Returns `null` outside a provider (so consumers can fall back to 0)
 *  - Provider with empty blockIds yields an empty Map and fires no IPC
 *  - Provider fetches counts via IPC and publishes them as a Map
 *  - IPC failure logs a warning and keeps the map empty
 *  - Re-fetches when blockIds membership changes
 *  - Does NOT re-fetch when blockIds reference changes but membership is identical
 */

import { invoke } from '@tauri-apps/api/core'
import { render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoggerWarn = vi.fn()
vi.mock('../../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import {
  BatchAttachmentCountsProvider,
  useBatchAttachmentCounts,
} from '../useBatchAttachmentCounts'

const mockedInvoke = vi.mocked(invoke)

function makeWrapper(blockIds: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <BatchAttachmentCountsProvider blockIds={blockIds}>{children}</BatchAttachmentCountsProvider>
  )
}

/** Probe captures the latest context value into the supplied collector. */
function Probe({ onResult }: { onResult: (counts: Map<string, number> | null) => void }) {
  const counts = useBatchAttachmentCounts()
  onResult(counts)
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue({})
})

describe('useBatchAttachmentCounts', () => {
  it('returns null outside a provider', () => {
    const { result } = renderHook(() => useBatchAttachmentCounts())
    expect(result.current).toBeNull()
  })

  it('provider returns empty map when blockIds is empty', async () => {
    const { result } = renderHook(() => useBatchAttachmentCounts(), {
      wrapper: makeWrapper([]),
    })

    expect(result.current).toBeInstanceOf(Map)
    expect(result.current?.size).toBe(0)

    // Allow any pending microtasks to flush
    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'get_batch_attachment_counts',
    )
    expect(batchCalls).toHaveLength(0)
  })

  it('provider fetches counts via IPC and publishes them', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_attachment_counts') return { BLOCK_1: 2, BLOCK_2: 5 }
      return undefined
    })

    const { result } = renderHook(() => useBatchAttachmentCounts(), {
      wrapper: makeWrapper(['BLOCK_1', 'BLOCK_2', 'BLOCK_3']),
    })

    await waitFor(() => {
      expect(result.current?.get('BLOCK_1')).toBe(2)
    })

    expect(result.current?.get('BLOCK_2')).toBe(5)
    expect(result.current?.get('BLOCK_3')).toBeUndefined()

    expect(mockedInvoke).toHaveBeenCalledWith('get_batch_attachment_counts', {
      blockIds: ['BLOCK_1', 'BLOCK_2', 'BLOCK_3'],
    })
  })

  it('logs warning and returns empty map on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_attachment_counts') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBatchAttachmentCounts(), {
      wrapper: makeWrapper(['BLOCK_1']),
    })

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })

    expect(result.current).toBeInstanceOf(Map)
    expect(result.current?.size).toBe(0)

    const [scope, message] = mockLoggerWarn.mock.calls[0] as [string, string]
    expect(scope).toBe('BatchAttachmentCountsProvider')
    expect(message).toBe('batch attachment counts failed')
  })

  it('refetches when blockIds membership changes', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_batch_attachment_counts') {
        const ids = (args as { blockIds: string[] }).blockIds
        const out: Record<string, number> = {}
        if (ids.includes('A')) out['A'] = 1
        if (ids.includes('B')) out['B'] = 2
        return out
      }
      return undefined
    })

    const observed: Array<Map<string, number> | null> = []
    const collect = (counts: Map<string, number> | null) => observed.push(counts)

    const { rerender } = render(
      <BatchAttachmentCountsProvider blockIds={['A']}>
        <Probe onResult={collect} />
      </BatchAttachmentCountsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')).toBe(1)
    })
    expect(observed.at(-1)?.get('B')).toBeUndefined()

    rerender(
      <BatchAttachmentCountsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentCountsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('B')).toBe(2)
    })
    expect(observed.at(-1)?.get('A')).toBe(1)

    const batchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'get_batch_attachment_counts',
    )
    expect(batchCalls).toHaveLength(2)
  })

  it('does NOT refetch when blockIds reference changes but membership is identical', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_attachment_counts') return { A: 1, B: 2 }
      return undefined
    })

    const observed: Array<Map<string, number> | null> = []
    const collect = (counts: Map<string, number> | null) => observed.push(counts)

    const { rerender } = render(
      <BatchAttachmentCountsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentCountsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')).toBe(1)
    })

    // New array literal, same membership
    rerender(
      <BatchAttachmentCountsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentCountsProvider>,
    )
    // Reordered — sorted key is identical
    rerender(
      <BatchAttachmentCountsProvider blockIds={['B', 'A']}>
        <Probe onResult={collect} />
      </BatchAttachmentCountsProvider>,
    )

    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'get_batch_attachment_counts',
    )
    expect(batchCalls).toHaveLength(1)
  })
})
