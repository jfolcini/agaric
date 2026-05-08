/**
 * Tests for useBatchProperties / BatchPropertiesProvider (PEND-35
 * Tier 2.4a).
 *
 * Validates:
 *  - Returns `null` outside a provider (consumer falls back to per-block fetch)
 *  - Provider with empty blockIds yields no entries and fires no IPC
 *  - Provider fetches FULL property lists via `get_batch_properties`
 *  - IPC failure logs a warning and keeps the cache empty
 *  - Re-fetches when blockIds membership changes
 *  - Does NOT re-fetch when blockIds reference changes but membership is identical
 *  - `invalidate(blockId)` triggers a refetch of the whole batch
 *  - `invalidationKey` prop bump triggers a refetch
 *  - `loading` flips during initial fetch and after invalidation
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoggerWarn = vi.fn()
vi.mock('../../lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import type { PropertyRow } from '../../lib/tauri'
import { BatchPropertiesProvider, useBatchProperties } from '../useBatchProperties'

const mockedInvoke = vi.mocked(invoke)

interface BatchPropertiesValue {
  get: (blockId: string) => PropertyRow[] | undefined
  loading: boolean
  invalidate: (blockId: string) => void
}

function makeWrapper(blockIds: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <BatchPropertiesProvider blockIds={blockIds}>{children}</BatchPropertiesProvider>
  )
}

/** Probe captures the latest context value into the supplied collector. */
function Probe({ onResult }: { onResult: (value: BatchPropertiesValue | null) => void }) {
  const value = useBatchProperties()
  onResult(value)
  return null
}

function makeRow(overrides: Partial<PropertyRow> = {}): PropertyRow {
  return {
    key: 'effort',
    value_text: '2h',
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue({})
})

describe('useBatchProperties', () => {
  it('returns null outside a provider', () => {
    const { result } = renderHook(() => useBatchProperties())
    expect(result.current).toBeNull()
  })

  it('provider returns empty map / loading=false when blockIds is empty', async () => {
    const { result } = renderHook(() => useBatchProperties(), {
      wrapper: makeWrapper([]),
    })

    expect(result.current?.get('ANY')).toBeUndefined()
    expect(result.current?.loading).toBe(false)

    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
    expect(batchCalls).toHaveLength(0)
  })

  it('provider fetches full lists via IPC and publishes them', async () => {
    const r1 = makeRow({ key: 'blocked_by', value_ref: 'X' })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') return { B1: [r1], B2: [] }
      return undefined
    })

    const { result } = renderHook(() => useBatchProperties(), {
      wrapper: makeWrapper(['B1', 'B2', 'B3']),
    })

    await waitFor(() => {
      expect(result.current?.get('B1')?.length).toBe(1)
    })

    expect(result.current?.get('B2')?.length).toBe(0)
    expect(result.current?.get('B3')).toBeUndefined()

    expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
      blockIds: ['B1', 'B2', 'B3'],
    })
  })

  it('logs warning and stays at empty cache on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBatchProperties(), {
      wrapper: makeWrapper(['B1']),
    })

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })

    expect(result.current?.get('B1')).toBeUndefined()
    expect(result.current?.loading).toBe(false)

    const [scope, message] = mockLoggerWarn.mock.calls[0] as [string, string]
    expect(scope).toBe('BatchPropertiesProvider')
    expect(message).toBe('batch properties fetch failed')
  })

  it('refetches when blockIds membership changes', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_batch_properties') {
        const ids = (args as { blockIds: string[] }).blockIds
        const out: Record<string, PropertyRow[]> = {}
        if (ids.includes('A')) out['A'] = [makeRow({ key: 'a' })]
        if (ids.includes('B')) out['B'] = [makeRow({ key: 'b' })]
        return out
      }
      return undefined
    })

    const observed: Array<BatchPropertiesValue | null> = []
    const collect = (v: BatchPropertiesValue | null) => observed.push(v)

    const { rerender } = render(
      <BatchPropertiesProvider blockIds={['A']}>
        <Probe onResult={collect} />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })
    expect(observed.at(-1)?.get('B')).toBeUndefined()

    rerender(
      <BatchPropertiesProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('B')?.length).toBe(1)
    })
    expect(observed.at(-1)?.get('A')?.length).toBe(1)

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
    expect(batchCalls).toHaveLength(2)
  })

  it('does NOT refetch when blockIds reference changes but membership is identical', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') {
        return {
          A: [makeRow({ key: 'a' })],
          B: [makeRow({ key: 'b' })],
        }
      }
      return undefined
    })

    const observed: Array<BatchPropertiesValue | null> = []
    const collect = (v: BatchPropertiesValue | null) => observed.push(v)

    const { rerender } = render(
      <BatchPropertiesProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })

    // New array literal, same membership
    rerender(
      <BatchPropertiesProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchPropertiesProvider>,
    )
    // Reordered — sorted key is identical
    rerender(
      <BatchPropertiesProvider blockIds={['B', 'A']}>
        <Probe onResult={collect} />
      </BatchPropertiesProvider>,
    )

    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
    expect(batchCalls).toHaveLength(1)
  })

  it('invalidate(blockId) triggers refetch', async () => {
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') {
        callCount += 1
        return {
          A:
            callCount === 1
              ? [makeRow({ key: 'a' })]
              : [makeRow({ key: 'a' }), makeRow({ key: 'a2' })],
        }
      }
      return undefined
    })

    const { result } = renderHook(() => useBatchProperties(), {
      wrapper: makeWrapper(['A']),
    })

    await waitFor(() => {
      expect(result.current?.get('A')?.length).toBe(1)
    })

    act(() => {
      result.current?.invalidate('A')
    })

    await waitFor(() => {
      expect(result.current?.get('A')?.length).toBe(2)
    })

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
    expect(batchCalls).toHaveLength(2)
  })

  it('invalidationKey prop bump triggers a refetch', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') return { A: [makeRow({ key: 'a' })] }
      return undefined
    })

    const { rerender } = render(
      <BatchPropertiesProvider blockIds={['A']} invalidationKey="v0">
        <Probe onResult={() => {}} />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
      expect(calls).toHaveLength(1)
    })

    rerender(
      <BatchPropertiesProvider blockIds={['A']} invalidationKey="v1">
        <Probe onResult={() => {}} />
      </BatchPropertiesProvider>,
    )

    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
      expect(calls).toHaveLength(2)
    })
  })

  it('loading is true during initial fetch and after invalidate', async () => {
    let resolveFetch!: (val: Record<string, PropertyRow[]>) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') {
        return new Promise<Record<string, PropertyRow[]>>((resolve) => {
          resolveFetch = resolve
        })
      }
      return undefined
    })

    const { result } = renderHook(() => useBatchProperties(), {
      wrapper: makeWrapper(['A']),
    })

    expect(result.current?.loading).toBe(true)

    await act(async () => {
      resolveFetch({ A: [makeRow({ key: 'a' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(false)
    })
    expect(result.current?.get('A')?.length).toBe(1)

    act(() => {
      result.current?.invalidate('A')
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(true)
    })

    await act(async () => {
      resolveFetch({ A: [makeRow({ key: 'a' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(false)
    })
  })
})
