/**
 * Tests for usePageDelete hook.
 *
 * Validates:
 *  - Setting and clearing delete target
 *  - Executing delete calls deleteBlock and updates pages list
 *  - Updates resolve store on successful delete
 *  - Shows success toast on delete
 *  - Shows error toast with retry on failed delete
 *  - Confirm delete executes deletion and clears target
 *  - deletingId tracks in-flight deletion
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { keyFor, useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { usePageDelete } from '../usePageDelete'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
  // FEAT-3p7 — pin the active space so `useResolveStore.set` composes
  // its cache key with a deterministic prefix.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('usePageDelete', () => {
  it('initializes with null deleteTarget and deletingId', () => {
    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    expect(result.current.deleteTarget).toBeNull()
    expect(result.current.deletingId).toBeNull()
  })

  it('sets and clears deleteTarget', () => {
    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    act(() => {
      result.current.setDeleteTarget({ id: 'P1', name: 'Test Page' })
    })
    expect(result.current.deleteTarget).toEqual({ id: 'P1', name: 'Test Page' })

    act(() => {
      result.current.setDeleteTarget(null)
    })
    expect(result.current.deleteTarget).toBeNull()
  })

  it('calls deleteBlock and removes page from list on success', async () => {
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    await act(async () => {
      await result.current.handleDeletePage('P1')
    })

    expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'P1' })
    expect(setPages).toHaveBeenCalledWith(expect.any(Function))

    // Verify the updater function filters out the deleted page
    // biome-ignore lint/style/noNonNullAssertion: test data — we just asserted setPages was called
    const updater = setPages.mock.calls[0]![0]
    const filtered = updater([
      { id: 'P1', content: 'Page 1' },
      { id: 'P2', content: 'Page 2' },
    ])
    expect(filtered).toEqual([{ id: 'P2', content: 'Page 2' }])
  })

  it('updates resolve store on successful delete', async () => {
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    await act(async () => {
      await result.current.handleDeletePage('P1')
    })

    const cached = useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'P1'))
    expect(cached).toEqual({ title: '(deleted)', deleted: true })
  })

  it('shows success toast after deletion', async () => {
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    await act(async () => {
      await result.current.handleDeletePage('P1')
    })

    expect(toast.success).toHaveBeenCalledWith('Page deleted')
  })

  it('shows error toast with retry on failed delete', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Network error'))

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    await act(async () => {
      await result.current.handleDeletePage('P1')
    })

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete page'),
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Retry' }),
      }),
    )
  })

  it('tracks deletingId during in-flight deletion', async () => {
    let resolveDelete!: (v: unknown) => void
    const pending = new Promise((resolve) => {
      resolveDelete = resolve
    })
    mockedInvoke.mockReturnValueOnce(pending)

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    let deletePromise: Promise<void>
    act(() => {
      deletePromise = result.current.handleDeletePage('P1')
    })

    // While in flight, deletingId should be set
    expect(result.current.deletingId).toBe('P1')

    // Resolve the delete
    await act(async () => {
      resolveDelete({
        block_id: 'P1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })
      await deletePromise
    })

    expect(result.current.deletingId).toBeNull()
  })

  it('handleConfirmDelete executes delete and clears target', async () => {
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    // Set a delete target first
    act(() => {
      result.current.setDeleteTarget({ id: 'P1', name: 'My Page' })
    })
    expect(result.current.deleteTarget).not.toBeNull()

    // Confirm delete
    act(() => {
      result.current.handleConfirmDelete()
    })

    // Target should be cleared immediately
    expect(result.current.deleteTarget).toBeNull()

    // Delete should have been called
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'P1' })
    })
  })

  it('handleConfirmDelete is a no-op when no target is set', () => {
    const setPages = vi.fn()
    const { result } = renderHook(() => usePageDelete(setPages))

    act(() => {
      result.current.handleConfirmDelete()
    })

    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
