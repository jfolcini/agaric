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

import type { AttachmentRow } from '../../lib/tauri'
import { BatchAttachmentsProvider, useBatchAttachments } from '../useBatchAttachments'

const mockedInvoke = vi.mocked(invoke)

interface BatchAttachmentsValue {
  get: (blockId: string) => AttachmentRow[] | undefined
  loading: boolean
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
    created_at: '2024-01-01T00:00:00Z',
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
    const { result } = renderHook(() => useBatchAttachments(), {
      wrapper: makeWrapper([]),
    })

    expect(result.current?.get('ANY')).toBeUndefined()
    expect(result.current?.loading).toBe(false)

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
    expect(result.current?.get('BLOCK_3')).toBeUndefined()

    expect(mockedInvoke).toHaveBeenCalledWith('list_attachments_batch', {
      blockIds: ['BLOCK_1', 'BLOCK_2', 'BLOCK_3'],
    })
  })

  it('logs warning and stays at empty cache on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments_batch') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBatchAttachments(), {
      wrapper: makeWrapper(['BLOCK_1']),
    })

    await waitFor(() => {
      expect(mockLoggerWarn).toHaveBeenCalled()
    })

    expect(result.current?.get('BLOCK_1')).toBeUndefined()
    expect(result.current?.loading).toBe(false)

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

    const { result } = renderHook(() => useBatchAttachments(), {
      wrapper: makeWrapper(['A']),
    })

    // Loading should be true while the initial fetch is pending.
    expect(result.current?.loading).toBe(true)

    await act(async () => {
      resolveFetch({ A: [makeAttachment({ id: 'a1', block_id: 'A' })] })
      // Allow the promise resolution to flush.
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(false)
    })
    expect(result.current?.get('A')?.length).toBe(1)

    // Now invalidate and confirm loading flips back to true.
    act(() => {
      result.current?.invalidate('A')
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(true)
    })

    await act(async () => {
      resolveFetch({ A: [makeAttachment({ id: 'a1', block_id: 'A' })] })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current?.loading).toBe(false)
    })
  })
})
