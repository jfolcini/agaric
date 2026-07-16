/**
 * Tests for useBatchPropertyRows / BatchPropertiesProvider (
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
 *  - `loading` (via `useBatchPropertyRowsLoading`) flips during initial
 *    fetch and after invalidation
 *  - #2701: a scroll settle with an overlapping window only fetches the ids
 *    NOT already cached; evicted ids are retained; `invalidate()` /
 *    `invalidationKey` bumps still force-refetch the whole current window;
 *    the data context value updates once per settle (the loading blip
 *    doesn't re-render data-only consumers, since it lives in a separate
 *    context).
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoggerWarn = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

import {
  BatchPropertiesProvider,
  useBatchPropertyRows,
  useBatchPropertyRowsLoading,
} from '@/hooks/useBatchPropertyRows'
import type { PropertyRow } from '@/lib/tauri'

const mockedInvoke = vi.mocked(invoke)

interface BatchPropertiesValue {
  get: (blockId: string) => PropertyRow[] | undefined
  invalidate: (blockId: string) => void
}

function makeWrapper(blockIds: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <BatchPropertiesProvider blockIds={blockIds}>{children}</BatchPropertiesProvider>
  )
}

/** Probe captures the latest context value into the supplied collector. */
function Probe({ onResult }: { onResult: (value: BatchPropertiesValue | null) => void }) {
  const value = useBatchPropertyRows()
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

describe('useBatchPropertyRows', () => {
  it('returns null outside a provider', () => {
    const { result } = renderHook(() => useBatchPropertyRows())
    expect(result.current).toBeNull()
  })

  it('provider returns empty map / loading=false when blockIds is empty', async () => {
    const { result } = renderHook(
      () => ({ data: useBatchPropertyRows(), loading: useBatchPropertyRowsLoading() }),
      { wrapper: makeWrapper([]) },
    )

    expect(result.current.data?.get('ANY')).toBeUndefined()
    expect(result.current.loading).toBe(false)

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

    const { result } = renderHook(() => useBatchPropertyRows(), {
      wrapper: makeWrapper(['B1', 'B2', 'B3']),
    })

    await waitFor(() => {
      expect(result.current?.get('B1')?.length).toBe(1)
    })

    expect(result.current?.get('B2')?.length).toBe(0)
    // #2701: B3 was requested and the response omitted it (no properties) —
    // the provider caches `[]` (not `undefined`) so the delta-fetch cache
    // can tell "confirmed empty" apart from "never fetched" (only the
    // latter needs a refetch when it re-enters a window).
    expect(result.current?.get('B3')).toEqual([])

    expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
      blockIds: ['B1', 'B2', 'B3'],
    })
  })

  it('logs warning and stays at empty cache on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_batch_properties') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(
      () => ({ data: useBatchPropertyRows(), loading: useBatchPropertyRowsLoading() }),
      { wrapper: makeWrapper(['B1']) },
    )

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })

    expect(result.current.data?.get('B1')).toBeUndefined()
    expect(result.current.loading).toBe(false)

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

    const { result } = renderHook(() => useBatchPropertyRows(), {
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

    const { result } = renderHook(
      () => ({ data: useBatchPropertyRows(), loading: useBatchPropertyRowsLoading() }),
      { wrapper: makeWrapper(['A']) },
    )

    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveFetch({ A: [makeRow({ key: 'a' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.data?.get('A')?.length).toBe(1)

    act(() => {
      result.current.data?.invalidate('A')
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(true)
    })

    await act(async () => {
      resolveFetch({ A: [makeRow({ key: 'a2' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // #2701 — delta fetching + single context commit per scroll settle
  // -------------------------------------------------------------------------

  describe('windowed scroll settle (#2701)', () => {
    function mockBatchInvoke() {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'get_batch_properties') {
          const ids = (args as { blockIds: string[] }).blockIds
          const out: Record<string, PropertyRow[]> = {}
          for (const id of ids) {
            out[id] = [makeRow({ key: `k-${id}` })]
          }
          return out
        }
        return undefined
      })
    }

    it('only fetches ids NOT already cached when the window overlaps', async () => {
      mockBatchInvoke()

      const observed: Array<BatchPropertiesValue | null> = []
      const collect = (v: BatchPropertiesValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchPropertiesProvider blockIds={['A', 'B', 'C']}>
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('C')?.length).toBe(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
        blockIds: ['A', 'B', 'C'],
      })

      mockedInvoke.mockClear()

      // Scroll settle: window shifts from [A,B,C] to [B,C,D] — B and C are
      // already cached, only D is new.
      rerender(
        <BatchPropertiesProvider blockIds={['B', 'C', 'D']}>
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('D')?.length).toBe(1)
      })

      const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
      expect(batchCalls).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', { blockIds: ['D'] })

      // A scrolled out of the window but stays readable from the cache
      // (evicted entries are retained, not refetched on re-entry).
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })

    it('re-entering a previously-fetched id does not refetch it', async () => {
      mockBatchInvoke()

      const { rerender } = render(
        <BatchPropertiesProvider blockIds={['A', 'B']}>
          <Probe onResult={() => {}} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
        expect(calls).toHaveLength(1)
      })

      // Scroll away — A drops out of the window.
      rerender(
        <BatchPropertiesProvider blockIds={['B']}>
          <Probe onResult={() => {}} />
        </BatchPropertiesProvider>,
      )
      await Promise.resolve()

      // Scroll back — A re-enters the window. No new IPC should fire since
      // A is still in the cache.
      rerender(
        <BatchPropertiesProvider blockIds={['A', 'B']}>
          <Probe onResult={() => {}} />
        </BatchPropertiesProvider>,
      )
      await Promise.resolve()

      const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
      expect(batchCalls).toHaveLength(1)
    })

    it('invalidate() force-refetches the whole current window, not just missing ids', async () => {
      mockBatchInvoke()

      const observed: Array<BatchPropertiesValue | null> = []
      const collect = (v: BatchPropertiesValue | null) => observed.push(v)

      render(
        <BatchPropertiesProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('B')?.length).toBe(1)
      })

      mockedInvoke.mockClear()

      act(() => {
        observed.at(-1)?.invalidate('A')
      })

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
        expect(calls).toHaveLength(1)
      })

      // Both A and B are refetched — not just A (the argument is a legacy
      // per-block hint; invalidate() always refreshes the whole window).
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
        blockIds: ['A', 'B'],
      })
    })

    it('invalidationKey bump (block:properties-changed) still refetches affected ids', async () => {
      mockBatchInvoke()

      const observed: Array<BatchPropertiesValue | null> = []
      const collect = (v: BatchPropertiesValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchPropertiesProvider blockIds={['A']} invalidationKey="v0">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('A')?.length).toBe(1)
      })

      mockedInvoke.mockClear()

      // Simulates AgendaResults/BlockTree wiring `invalidationKey` to
      // `useBlockPropertyEvents().invalidationKey` — a debounced
      // `block:properties-changed` event bumps the key.
      rerender(
        <BatchPropertiesProvider blockIds={['A']} invalidationKey="v1">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
        expect(calls).toHaveLength(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', { blockIds: ['A'] })
    })

    it('invalidationKey bump while a previously-cached id is OFF the current window purges it, so scrolling back refetches fresh instead of serving stale data', async () => {
      mockBatchInvoke()

      const observed: Array<BatchPropertiesValue | null> = []
      const collect = (v: BatchPropertiesValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchPropertiesProvider blockIds={['A', 'B']} invalidationKey="v0">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )
      await waitFor(() => {
        expect(observed.at(-1)?.get('A')?.length).toBe(1)
      })

      // Scroll away — A and B drop out of the window; C and D scroll in.
      rerender(
        <BatchPropertiesProvider blockIds={['C', 'D']} invalidationKey="v0">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )
      await waitFor(() => {
        expect(observed.at(-1)?.get('D')?.length).toBe(1)
      })

      mockedInvoke.mockClear()

      // A property edit on A fires elsewhere (A is off-window — e.g. an
      // Agenda/DuePanel edit, or a recurring-task rollover). This bumps the
      // GLOBAL `block:properties-changed` invalidationKey, which carries no
      // id information — the provider can only force-refetch its CURRENT
      // window [C, D].
      rerender(
        <BatchPropertiesProvider blockIds={['C', 'D']} invalidationKey="v1">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )
      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
        expect(calls).toHaveLength(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', { blockIds: ['C', 'D'] })

      mockedInvoke.mockClear()

      // Scroll back to A, B at the same invalidationKey ('v1' — no further
      // edits happened). Since the invalidation above could not know A was
      // the mutated id, A's cache entry must have been purged (not silently
      // retained as pre-mutation data) — re-entering the window must
      // trigger a fresh fetch, not a cache hit serving stale data.
      rerender(
        <BatchPropertiesProvider blockIds={['A', 'B']} invalidationKey="v1">
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_batch_properties')
        expect(calls).toHaveLength(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('get_batch_properties', {
        blockIds: ['A', 'B'],
      })
    })

    it('data context value updates once per settle — the loading blip does not re-render data-only consumers', async () => {
      mockBatchInvoke()

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

      // Scroll settle: window grows to include a new id (B), forcing a real
      // fetch cycle (setLoading(true) → resolve → setPropertiesByBlock).
      rerender(
        <BatchPropertiesProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchPropertiesProvider>,
      )
      // The rerender() call itself produces one Probe render (new `children`
      // element identity from the test harness) — snapshot the count here so
      // the assertion below isolates just the async fetch cycle.
      const rendersAfterRerenderCommit = observed.length

      await waitFor(() => {
        expect(observed.at(-1)?.get('B')?.length).toBe(1)
      })

      // Exactly one additional Probe render for the whole async fetch cycle:
      // `loading` lives in a separate context, so the setLoading(true) blip
      // that precedes the data landing does not re-render a consumer that
      // only reads `useBatchPropertyRows()`.
      expect(observed.length - rendersAfterRerenderCommit).toBe(1)
    })
  })
})
