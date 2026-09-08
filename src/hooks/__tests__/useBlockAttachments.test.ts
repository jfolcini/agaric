/**
 * Tests for useBlockAttachments hook — attachment loading, deleting, and renaming.
 *
 * Validates:
 * - loads attachments on mount via listAttachments
 * - handleDeleteAttachment calls deleteAttachment IPC and notifies undo store
 * - handleDeleteAttachment does not notify undo on failure
 * - loading state transitions correctly
 * Skips the per-block listAttachments IPC when an
 *   active BatchAttachmentsProvider already holds the rows
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { BatchAttachmentsProvider } from '@/hooks/useBatchAttachments'
import { useBlockAttachments } from '@/hooks/useBlockAttachments'
import {
  _resetAttachmentInvalidationForTest,
  recordAttachmentInvalidation,
} from '@/lib/attachment-invalidation'
import type { AttachmentRow } from '@/lib/bindings'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

const mockedToastError = vi.mocked(toast.error)
const mockedToastSuccess = vi.mocked(toast.success)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

const originalOnNewAction = useUndoStore.getState().onNewAction
afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

function makeAttachmentRow(id: string, blockId: string, filename: string): AttachmentRow {
  return {
    id,
    block_id: blockId,
    filename,
    mime_type: 'application/pdf',
    size_bytes: 12345,
    fs_path: `/files/${filename}`,
    // Epoch-ms since migration 0081 — the literal here was an ISO string.
    created_at: 1735689600000,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  stubInvoke({ list_attachments: () => [] })
  pageStore = createPageBlockStore('PAGE_1')
  _resetAttachmentInvalidationForTest()
})

// ---------------------------------------------------------------------------
// loads attachments on mount
// ---------------------------------------------------------------------------

describe('useBlockAttachments loading', () => {
  it('loads attachments on mount', async () => {
    const rows = [
      makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf'),
      makeAttachmentRow('ATT_2', 'BLOCK_1', 'file2.png'),
    ]
    stubInvoke({ list_attachments: () => rows })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(2)
    })

    expect(result.current.attachments).toEqual(rows)

    expect(mockedInvoke).toHaveBeenCalledWith('list_attachments', {
      blockId: 'BLOCK_1',
    })
  })

  it('resets attachments when blockId is null', async () => {
    const { result } = renderHook(() => useBlockAttachments(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.attachments).toHaveLength(0)
    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments')
    expect(listCalls).toHaveLength(0)
  })

  // #4335 review — an out-of-band mutation (a History-view revert/restore)
  // bypasses `handleDeleteAttachment`/`handleRenameAttachment` entirely, so
  // this hook (outside a BatchAttachmentsProvider) needs the cross-tree bus
  // to know it should refetch.
  it('refetches when the cross-tree attachment-invalidation bus fires', async () => {
    let callCount = 0
    stubInvoke({
      list_attachments: () => {
        callCount += 1
        return callCount === 1
          ? [makeAttachmentRow('ATT_1', 'BLOCK_1', 'draft.txt')]
          : [makeAttachmentRow('ATT_1', 'BLOCK_1', 'final.txt')]
      },
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.attachments[0]?.filename).toBe('draft.txt')
    })

    act(() => {
      recordAttachmentInvalidation()
    })

    await waitFor(() => {
      expect(result.current.attachments[0]?.filename).toBe('final.txt')
    })

    const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments')
    expect(listCalls).toHaveLength(2)
  })

  it('shows toast error when loading attachments fails', async () => {
    stubInvoke({
      list_attachments: () => {
        throw new Error('Network error')
      },
    })

    renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'Failed to load attachments',
        expect.objectContaining({ id: 'attachments-load-failed' }),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// loading state transitions
// ---------------------------------------------------------------------------

describe('useBlockAttachments loading state', () => {
  it('loading starts true and becomes false after attachments load', async () => {
    let resolveList!: (value: AttachmentRow[]) => void
    stubInvoke({
      list_attachments: () =>
        new Promise<AttachmentRow[]>((resolve) => {
          resolveList = resolve
        }),
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    // loading should be true while waiting
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveList([makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf')])
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.attachments).toHaveLength(1)
  })

  it('loading becomes false even when listAttachments fails', async () => {
    let rejectList!: (reason: Error) => void
    stubInvoke({
      list_attachments: () =>
        new Promise<AttachmentRow[]>((_resolve, reject) => {
          rejectList = reject
        }),
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    expect(result.current.loading).toBe(true)

    await act(async () => {
      rejectList(new Error('DB error'))
    })

    expect(result.current.loading).toBe(false)
  })

  it('loading becomes false immediately when blockId is null', async () => {
    const { result } = renderHook(() => useBlockAttachments(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// handleDeleteAttachment
// ---------------------------------------------------------------------------

describe('useBlockAttachments handleDeleteAttachment', () => {
  it('calls deleteAttachment IPC and notifies undo store', async () => {
    const onNewActionSpy = vi.fn()
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    const existing = [
      makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf'),
      makeAttachmentRow('ATT_2', 'BLOCK_1', 'file2.pdf'),
    ]

    stubInvoke({ list_attachments: () => existing, delete_attachment: () => null })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleDeleteAttachment('ATT_1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_attachment', {
      attachmentId: 'ATT_1',
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
    expect(result.current.attachments).toHaveLength(1)
    expect(result.current.attachments[0]?.id).toBe('ATT_2')
    expect(mockedToastSuccess).toHaveBeenCalledTimes(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith('Deleted file1.pdf')
  })

  it('does not notify undo on failure', async () => {
    const onNewActionSpy = vi.fn()
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    const existing = [makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf')]

    stubInvoke({
      list_attachments: () => existing,
      delete_attachment: () => {
        throw new Error('IPC failed')
      },
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1)
    })

    await act(async () => {
      await result.current.handleDeleteAttachment('ATT_1')
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
    expect(mockedToastError).toHaveBeenCalledWith('Failed to delete attachment')
    // Attachment should still be present (no removal on failure)
    expect(result.current.attachments).toHaveLength(1)
    expect(mockedToastSuccess).not.toHaveBeenCalled()
  })

  it('does nothing when blockId is null', async () => {
    stubInvoke({ delete_attachment: () => null })

    const { result } = renderHook(() => useBlockAttachments(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleDeleteAttachment('ATT_1')
    })

    const deleteCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_attachment')
    expect(deleteCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// error paths — mockRejectedValueOnce for each invoke call
// ---------------------------------------------------------------------------

describe('useBlockAttachments error paths', () => {
  it('listAttachments rejection shows toast and falls back to empty attachments', async () => {
    stubInvoke({ list_attachments: () => Promise.reject(new Error('DB connection lost')) })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(mockedToastError).toHaveBeenCalledWith(
      'Failed to load attachments',
      expect.objectContaining({ id: 'attachments-load-failed' }),
    )
    expect(result.current.attachments).toEqual([])
  })

  it('deleteAttachment rejection shows toast and preserves all attachments', async () => {
    const existing = [
      makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf'),
      makeAttachmentRow('ATT_2', 'BLOCK_1', 'file2.pdf'),
    ]
    stubInvoke({
      list_attachments: () => existing,
      delete_attachment: () => Promise.reject(new Error('FK constraint')),
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(2)
    })

    await act(async () => {
      await result.current.handleDeleteAttachment('ATT_1')
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to delete attachment')
    // All attachments must remain after failed deletion
    expect(result.current.attachments).toEqual(existing)
    expect(mockedToastSuccess).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Skip per-block listAttachments IPC when batch provider
// already has the data
// ---------------------------------------------------------------------------

describe('useBlockAttachments batch-provider seeding', () => {
  it('uses BatchAttachmentsProvider rows and does NOT fire listAttachments IPC', async () => {
    const seeded = [
      makeAttachmentRow('ATT_1', 'BLOCK_BATCH_1', 'a.pdf'),
      makeAttachmentRow('ATT_2', 'BLOCK_BATCH_1', 'b.png'),
    ]

    // Provider's `list_attachments_batch` IPC returns the seeded rows.
    // The per-block `list_attachments` IPC must NEVER fire when the batch
    // already holds the rows.
    stubInvoke({
      list_attachments_batch: () => ({ BLOCK_BATCH_1: seeded }),
      list_attachments: () => [], // would be wrong if hit
    })

    const batchWrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        PageBlockContext.Provider,
        { value: pageStore },
        // oxlint-disable-next-line react/no-children-prop -- createElement in a .ts file (no JSX); BatchAttachmentsProvider's props type requires `children`, so it must be passed in props
        createElement(BatchAttachmentsProvider, { blockIds: ['BLOCK_BATCH_1'], children }),
      )

    const { result } = renderHook(() => useBlockAttachments('BLOCK_BATCH_1'), {
      wrapper: batchWrapper,
    })

    // Wait until the batch fetch resolves and the hook seeds local state.
    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(2)
    })
    expect(result.current.attachments).toEqual(seeded)
    expect(result.current.loading).toBe(false)

    // Critical assertion — the per-block IPC must not fire.
    const perBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments')
    expect(perBlockCalls).toHaveLength(0)
  })

  it('falls back to listAttachments IPC when no provider is mounted', async () => {
    const rows = [makeAttachmentRow('ATT_1', 'BLOCK_NOBATCH', 'x.pdf')]
    stubInvoke({ list_attachments: () => rows })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_NOBATCH'), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1)
    })

    const perBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_attachments')
    expect(perBlockCalls).toHaveLength(1)
  })
})
