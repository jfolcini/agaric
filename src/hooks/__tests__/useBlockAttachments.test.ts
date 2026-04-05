/**
 * Tests for useBlockAttachments hook — attachment loading, adding, and deleting.
 *
 * Validates:
 * - loads attachments on mount via listAttachments
 * - handleAddAttachment calls addAttachment IPC and notifies undo store
 * - handleDeleteAttachment calls deleteAttachment IPC and notifies undo store
 * - handleAddAttachment does not notify undo on failure
 * - handleDeleteAttachment does not notify undo on failure
 * - loading state transitions correctly
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'
import { useBlockAttachments } from '../useBlockAttachments'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

let pageStore: StoreApi<PageBlockState>
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PageBlockContext.Provider, { value: pageStore }, children)

function makeAttachmentRow(id: string, blockId: string, filename: string) {
  return {
    id,
    block_id: blockId,
    filename,
    mime_type: 'application/pdf',
    size_bytes: 12345,
    fs_path: `/files/${filename}`,
    created_at: '2025-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue([])
  pageStore = createPageBlockStore('PAGE_1')
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
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') return rows
      return []
    })

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

  it('shows toast error when loading attachments fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') throw new Error('Network error')
      return []
    })

    renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to load attachments')
    })
  })
})

// ---------------------------------------------------------------------------
// loading state transitions
// ---------------------------------------------------------------------------

describe('useBlockAttachments loading state', () => {
  it('loading starts true and becomes false after attachments load', async () => {
    let resolveList!: (value: unknown[]) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') {
        return new Promise<unknown[]>((resolve) => {
          resolveList = resolve
        })
      }
      return []
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
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') {
        return new Promise<unknown[]>((_resolve, reject) => {
          rejectList = reject
        })
      }
      return []
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
// handleAddAttachment
// ---------------------------------------------------------------------------

describe('useBlockAttachments handleAddAttachment', () => {
  it('calls addAttachment IPC and notifies undo store', async () => {
    const onNewActionSpy = vi.fn()
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    const newRow = makeAttachmentRow('ATT_NEW', 'BLOCK_1', 'new.pdf')

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') return []
      if (cmd === 'add_attachment') return newRow
      return undefined
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddAttachment(
        'new.pdf',
        'application/pdf',
        12345,
        '/files/new.pdf',
      )
    })

    expect(mockedInvoke).toHaveBeenCalledWith('add_attachment', {
      blockId: 'BLOCK_1',
      filename: 'new.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12345,
      fsPath: '/files/new.pdf',
    })

    expect(onNewActionSpy).toHaveBeenCalledWith('PAGE_1')
    expect(result.current.attachments).toEqual([newRow])
  })

  it('does not notify undo on failure', async () => {
    const onNewActionSpy = vi.fn()
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') return []
      if (cmd === 'add_attachment') throw new Error('IPC failed')
      return undefined
    })

    const { result } = renderHook(() => useBlockAttachments('BLOCK_1'), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddAttachment(
        'fail.pdf',
        'application/pdf',
        100,
        '/files/fail.pdf',
      )
    })

    expect(onNewActionSpy).not.toHaveBeenCalled()
    expect(mockedToastError).toHaveBeenCalledWith('Failed to add attachment')
    expect(result.current.attachments).toHaveLength(0)
  })

  it('does nothing when blockId is null', async () => {
    mockedInvoke.mockResolvedValue(undefined)

    const { result } = renderHook(() => useBlockAttachments(null), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.handleAddAttachment(
        'file.pdf',
        'application/pdf',
        100,
        '/files/file.pdf',
      )
    })

    const addCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'add_attachment')
    expect(addCalls).toHaveLength(0)
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

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') return existing
      if (cmd === 'delete_attachment') return undefined
      return undefined
    })

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
  })

  it('does not notify undo on failure', async () => {
    const onNewActionSpy = vi.fn()
    // pageStore already has rootParentId: 'PAGE_1' from createPageBlockStore
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction: onNewActionSpy })

    const existing = [makeAttachmentRow('ATT_1', 'BLOCK_1', 'file1.pdf')]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_attachments') return existing
      if (cmd === 'delete_attachment') throw new Error('IPC failed')
      return undefined
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
  })

  it('does nothing when blockId is null', async () => {
    mockedInvoke.mockResolvedValue(undefined)

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
