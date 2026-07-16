/**
 * Tests for useBatchAttachments / BatchAttachmentsProvider.
 *
 * Validates:
 *  - Returns `null` outside a provider (so consumers can fall back to [])
 *  - Provider with empty blockIds yields no entries and fires no IPC
 *  - Provider fetches FULL attachment lists via IPC and publishes them
 *  - IPC failure logs a warning and keeps the cache empty
 *  - Re-fetches when blockIds membership changes
 *  - Does NOT re-fetch when blockIds reference changes but membership is identical
 *  - `invalidate(blockId)` triggers a refetch of the whole batch
 *  - `loading` (via `useBatchAttachmentsLoading`) flips during initial fetch
 *    and after invalidation
 * `getCount(blockId)` returns `rows.length` (or 0 when
 *    the block is absent from the cache) — replaces the dropped
 *    BatchAttachmentCountsProvider.
 *  - #2701: a scroll settle with an overlapping window only fetches the ids
 *    NOT already cached; evicted ids are retained (not refetched on
 *    re-entry); `invalidate()` still force-refetches the whole current
 *    window; the data context value updates once per settle (the loading
 *    blip doesn't re-render data-only consumers, since it lives in a
 *    separate context).
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
  BatchAttachmentsProvider,
  useBatchAttachments,
  useBatchAttachmentsLoading,
} from '@/hooks/useBatchAttachments'
import type { AttachmentRow } from '@/lib/tauri'

const mockedInvoke = vi.mocked(invoke)

interface BatchAttachmentsValue {
  get: (blockId: string) => AttachmentRow[] | undefined
  getCount: (blockId: string) => number
  invalidate: (blockId: string) => void
}

function makeWrapper(blockIds: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <BatchAttachmentsProvider blockIds={blockIds}>{children}</BatchAttachmentsProvider>
  )
}

/** Probe captures the latest context value into the supplied collector. */
function Probe({ onResult }: { onResult: (value: BatchAttachmentsValue | null) => void }) {
  const value = useBatchAttachments()
  onResult(value)
  return null
}

function makeAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'att-1',
    block_id: 'BLOCK_1',
    filename: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 1024,
    fs_path: '/tmp/photo.png',
    created_at: 1704067200000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue({})
})

describe('useBatchAttachments', () => {
  it('returns null outside a provider', () => {
    const { result } = renderHook(() => useBatchAttachments())
    expect(result.current).toBeNull()
  })

  it('provider returns empty map / loading=false when blockIds is empty', async () => {
    const { result } = renderHook(
      () => ({ data: useBatchAttachments(), loading: useBatchAttachmentsLoading() }),
      { wrapper: makeWrapper([]) },
    )

    expect(result.current.data?.get('ANY')).toBeUndefined()
    expect(result.current.loading).toBe(false)

    // Allow any pending microtasks to flush
    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
    expect(batchCalls).toHaveLength(0)
  })

  it('provider fetches full lists via IPC and publishes them', async () => {
    const att1 = makeAttachment({ id: 'att-1', block_id: 'BLOCK_1' })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') return { BLOCK_1: [att1], BLOCK_2: [] }
      return undefined
    })

    const { result } = renderHook(() => useBatchAttachments(), {
      wrapper: makeWrapper(['BLOCK_1', 'BLOCK_2', 'BLOCK_3']),
    })

    await waitFor(() => {
      expect(result.current?.get('BLOCK_1')?.length).toBe(1)
    })

    expect(result.current?.get('BLOCK_2')?.length).toBe(0)
    // #2701: BLOCK_3 was requested and the response omitted it (no
    // attachments) — the provider caches `[]` (not `undefined`) so the
    // delta-fetch cache can tell "confirmed empty" apart from "never
    // fetched" (only the latter needs a refetch when it re-enters a window).
    expect(result.current?.get('BLOCK_3')).toEqual([])

    expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2', 'BLOCK_3'],
    })
  })

  it('logs warning and stays at empty cache on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(
      () => ({ data: useBatchAttachments(), loading: useBatchAttachmentsLoading() }),
      { wrapper: makeWrapper(['BLOCK_1']) },
    )

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })

    expect(result.current.data?.get('BLOCK_1')).toBeUndefined()
    expect(result.current.loading).toBe(false)

    const [scope, message] = mockLoggerWarn.mock.calls[0] as [string, string]
    expect(scope).toBe('BatchAttachmentsProvider')
    expect(message).toBe('batch attachments fetch failed')
  })

  it('refetches when blockIds membership changes', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_attachments_batch') {
        const ids = (args as { blockIds: string[] }).blockIds
        const out: Record<string, AttachmentRow[]> = {}
        if (ids.includes('A')) out['A'] = [makeAttachment({ id: 'a1', block_id: 'A' })]
        if (ids.includes('B')) out['B'] = [makeAttachment({ id: 'b1', block_id: 'B' })]
        return out
      }
      return undefined
    })

    const observed: Array<BatchAttachmentsValue | null> = []
    const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

    const { rerender } = render(
      <BatchAttachmentsProvider blockIds={['A']}>
        <Probe onResult={collect} />
      </BatchAttachmentsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })
    expect(observed.at(-1)?.get('B')).toBeUndefined()

    rerender(
      <BatchAttachmentsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('B')?.length).toBe(1)
    })
    expect(observed.at(-1)?.get('A')?.length).toBe(1)

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
    expect(batchCalls).toHaveLength(2)
  })

  it('does NOT refetch when blockIds reference changes but membership is identical', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') {
        return {
          A: [makeAttachment({ id: 'a1', block_id: 'A' })],
          B: [makeAttachment({ id: 'b1', block_id: 'B' })],
        }
      }
      return undefined
    })

    const observed: Array<BatchAttachmentsValue | null> = []
    const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

    const { rerender } = render(
      <BatchAttachmentsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentsProvider>,
    )

    await waitFor(() => {
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })

    // New array literal, same membership
    rerender(
      <BatchAttachmentsProvider blockIds={['A', 'B']}>
        <Probe onResult={collect} />
      </BatchAttachmentsProvider>,
    )
    // Reordered — sorted key is identical
    rerender(
      <BatchAttachmentsProvider blockIds={['B', 'A']}>
        <Probe onResult={collect} />
      </BatchAttachmentsProvider>,
    )

    await Promise.resolve()

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
    expect(batchCalls).toHaveLength(1)
  })

  it('invalidate(blockId) triggers refetch', async () => {
    const att1 = makeAttachment({ id: 'a1', block_id: 'A' })
    const att2 = makeAttachment({ id: 'a2', block_id: 'A', filename: 'second.png' })

    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') {
        callCount += 1
        return callCount === 1 ? { A: [att1] } : { A: [att1, att2] }
      }
      return undefined
    })

    const { result } = renderHook(() => useBatchAttachments(), {
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

    const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
    expect(batchCalls).toHaveLength(2)
  })

  it('loading is true during initial fetch and after invalidate', async () => {
    let resolveFetch!: (val: Record<string, AttachmentRow[]>) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') {
        return new Promise<Record<string, AttachmentRow[]>>((resolve) => {
          resolveFetch = resolve
        })
      }
      return undefined
    })

    const { result } = renderHook(
      () => ({ data: useBatchAttachments(), loading: useBatchAttachmentsLoading() }),
      { wrapper: makeWrapper(['A']) },
    )

    // Loading should be true while the initial fetch is pending.
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveFetch({ A: [makeAttachment({ id: 'a1', block_id: 'A' })] })
      // Allow the promise resolution to flush.
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.data?.get('A')?.length).toBe(1)

    // Now invalidate and confirm loading flips back to true.
    act(() => {
      result.current.data?.invalidate('A')
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(true)
    })

    await act(async () => {
      resolveFetch({ A: [makeAttachment({ id: 'a2', block_id: 'A' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // GetCount derives `rows.length` from the same cache
  // -------------------------------------------------------------------------

  describe('getCount', () => {
    it('returns rows.length for cached blocks', async () => {
      const a1 = makeAttachment({ id: 'a1', block_id: 'A' })
      const a2 = makeAttachment({ id: 'a2', block_id: 'A', filename: 'second.png' })
      const b1 = makeAttachment({ id: 'b1', block_id: 'B' })

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_attachments_batch') return { A: [a1, a2], B: [b1] }
        return undefined
      })

      const { result } = renderHook(() => useBatchAttachments(), {
        wrapper: makeWrapper(['A', 'B', 'C']),
      })

      await waitFor(() => {
        expect(result.current?.getCount('A')).toBe(2)
      })
      expect(result.current?.getCount('B')).toBe(1)
      // C is absent from the response (no attachments) — must default to 0.
      expect(result.current?.getCount('C')).toBe(0)
    })

    it('returns 0 for unknown blockId before the fetch completes', () => {
      // No mock resolution — the initial fetch promise stays pending. The
      // map is still empty so getCount must not throw.
      const { result } = renderHook(() => useBatchAttachments(), {
        wrapper: makeWrapper(['A']),
      })
      expect(result.current?.getCount('A')).toBe(0)
      expect(result.current?.getCount('NONEXISTENT')).toBe(0)
    })

    it('does NOT issue a separate IPC for counts (single source: list batch)', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_attachments_batch') return { A: [makeAttachment()] }
        return undefined
      })

      const { result } = renderHook(() => useBatchAttachments(), {
        wrapper: makeWrapper(['A']),
      })

      await waitFor(() => {
        expect(result.current?.getCount('A')).toBe(1)
      })

      // Regression for the dropped count batch must
      // never fire — this hook is now the sole source of attachment data.
      const countCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_batch_attachment_counts',
      )
      expect(countCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // #2701 — delta fetching + single context commit per scroll settle
  // -------------------------------------------------------------------------

  describe('windowed scroll settle (#2701)', () => {
    function mockBatchInvoke() {
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_attachments_batch') {
          const ids = (args as { blockIds: string[] }).blockIds
          const out: Record<string, AttachmentRow[]> = {}
          for (const id of ids) {
            out[id] = [makeAttachment({ id: `att-${id}`, block_id: id })]
          }
          return out
        }
        return undefined
      })
    }

    it('clears loading when a superseded fetch is followed by an all-cached window (stranded-loading regression)', async () => {
      // First settle: [A] resolves normally and is cached.
      mockBatchInvoke()
      const loadingStates: boolean[] = []
      function LoadingProbe() {
        loadingStates.push(useBatchAttachmentsLoading())
        return null
      }
      const { rerender } = render(
        <BatchAttachmentsProvider blockIds={['A']}>
          <LoadingProbe />
        </BatchAttachmentsProvider>,
      )
      await waitFor(() => expect(loadingStates.at(-1)).toBe(false))

      // Second settle: [A, B] — only B is fetched; hold its promise open so
      // the fetch is still in flight when the window changes again.
      let resolveB: ((v: Record<string, AttachmentRow[]>) => void) | undefined
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_attachments_batch') {
          return new Promise((res) => {
            resolveB = res
          })
        }
        return Promise.resolve(undefined)
      })
      rerender(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <LoadingProbe />
        </BatchAttachmentsProvider>,
      )
      await waitFor(() => expect(loadingStates.at(-1)).toBe(true))

      // Third settle BEFORE B resolves: back to the fully-cached [A].
      // idsToFetch is empty; loading must reset even though B's in-flight
      // fetch will be stale-guarded and never call setLoading(false).
      rerender(
        <BatchAttachmentsProvider blockIds={['A']}>
          <LoadingProbe />
        </BatchAttachmentsProvider>,
      )
      await waitFor(() => expect(loadingStates.at(-1)).toBe(false))

      // The superseded resolution must not flip loading back on.
      resolveB?.({ B: [] })
      await Promise.resolve()
      expect(loadingStates.at(-1)).toBe(false)
    })

    it('only fetches ids NOT already cached when the window overlaps', async () => {
      mockBatchInvoke()

      const observed: Array<BatchAttachmentsValue | null> = []
      const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchAttachmentsProvider blockIds={['A', 'B', 'C']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('C')?.length).toBe(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
        blockIds: ['A', 'B', 'C'],
      })

      mockedInvoke.mockClear()

      // Scroll settle: window shifts from [A,B,C] to [B,C,D] — B and C are
      // already cached, only D is new.
      rerender(
        <BatchAttachmentsProvider blockIds={['B', 'C', 'D']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('D')?.length).toBe(1)
      })

      const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
      expect(batchCalls).toHaveLength(1)
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', { blockIds: ['D'] })

      // A scrolled out of the window but stays readable from the cache
      // (evicted entries are retained, not refetched on re-entry).
      expect(observed.at(-1)?.get('A')?.length).toBe(1)
    })

    it('re-entering a previously-fetched id does not refetch it', async () => {
      mockBatchInvoke()

      const { rerender } = render(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={() => {}} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
        expect(calls).toHaveLength(1)
      })

      // Scroll away — A drops out of the window.
      rerender(
        <BatchAttachmentsProvider blockIds={['B']}>
          <Probe onResult={() => {}} />
        </BatchAttachmentsProvider>,
      )
      await Promise.resolve()

      // Scroll back — A re-enters the window. No new IPC should fire since
      // A is still in the cache.
      rerender(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={() => {}} />
        </BatchAttachmentsProvider>,
      )
      await Promise.resolve()

      const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
      expect(batchCalls).toHaveLength(1)
    })

    it('invalidate() force-refetches the whole current window, not just missing ids', async () => {
      mockBatchInvoke()

      const observed: Array<BatchAttachmentsValue | null> = []
      const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

      render(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('B')?.length).toBe(1)
      })

      mockedInvoke.mockClear()

      act(() => {
        observed.at(-1)?.invalidate('A')
      })

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
        expect(calls).toHaveLength(1)
      })

      // Both A and B are refetched — not just A (the argument is a legacy
      // per-block hint; invalidate() always refreshes the whole window).
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
        blockIds: ['A', 'B'],
      })
    })

    it('invalidate() while a previously-cached id is OFF the current window purges it, so scrolling back refetches fresh instead of serving stale data', async () => {
      mockBatchInvoke()

      const observed: Array<BatchAttachmentsValue | null> = []
      const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )
      await waitFor(() => {
        expect(observed.at(-1)?.get('A')?.length).toBe(1)
      })

      // Scroll away — A and B drop out of the window; C and D scroll in.
      rerender(
        <BatchAttachmentsProvider blockIds={['C', 'D']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )
      await waitFor(() => {
        expect(observed.at(-1)?.get('D')?.length).toBe(1)
      })

      mockedInvoke.mockClear()

      // A mutation on A fires while A is OFF-window (e.g. an attachment add
      // via a surface other than the currently-scrolled StaticBlock rows).
      // `invalidate()` has no id-scoping, so this only force-refetches the
      // CURRENT window [C, D] — it cannot know to specifically refresh A.
      act(() => {
        observed.at(-1)?.invalidate('A')
      })
      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
        expect(calls).toHaveLength(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', { blockIds: ['C', 'D'] })

      mockedInvoke.mockClear()

      // Scroll back to A, B. Since the invalidation above could not know
      // A was the mutated id, the cache entry for A must have been purged
      // (not silently retained as pre-mutation data) — so re-entering the
      // window must trigger a fresh fetch, not a cache hit.
      rerender(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments_batch')
        expect(calls).toHaveLength(1)
      })
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
        blockIds: ['A', 'B'],
      })
    })

    it('data context value updates once per settle — the loading blip does not re-render data-only consumers', async () => {
      mockBatchInvoke()

      const observed: Array<BatchAttachmentsValue | null> = []
      const collect = (v: BatchAttachmentsValue | null) => observed.push(v)

      const { rerender } = render(
        <BatchAttachmentsProvider blockIds={['A']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
      )

      await waitFor(() => {
        expect(observed.at(-1)?.get('A')?.length).toBe(1)
      })

      // Scroll settle: window grows to include a new id (B), forcing a real
      // fetch cycle (setLoading(true) → resolve → setAttachmentsByBlock).
      rerender(
        <BatchAttachmentsProvider blockIds={['A', 'B']}>
          <Probe onResult={collect} />
        </BatchAttachmentsProvider>,
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
      // only reads `useBatchAttachments()`.
      expect(observed.length - rendersAfterRerenderCommit).toBe(1)
    })
  })
})
