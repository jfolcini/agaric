/** Tests for the shared confirm → delete → Undo → restore page flow. */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type InvokeHandler, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { usePageDeleteAction } from '@/hooks/usePageDeleteAction'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(overrides: Readonly<Record<string, InvokeHandler>>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(overrides))
}

function Harness({ onReady }: { onReady: (api: ReturnType<typeof usePageDeleteAction>) => void }) {
  const api = usePageDeleteAction()
  onReady(api)
  return <>{api.confirmDialog}</>
}

function renderHarness(): { api: ReturnType<typeof usePageDeleteAction> } {
  const holder: { api: ReturnType<typeof usePageDeleteAction> | null } = { api: null }
  render(
    <Harness
      onReady={(api) => {
        holder.api = api
      }}
    />,
  )
  if (!holder.api) throw new Error('Harness did not yield an api')
  return holder as { api: ReturnType<typeof usePageDeleteAction> }
}

function lastUndoAction(): () => void {
  const lastCall = vi.mocked(toast.success).mock.calls.at(-1)
  const options = lastCall?.[1] as { action?: { onClick?: () => void } } | undefined
  const onClick = options?.action?.onClick
  if (!onClick) throw new Error('Expected the success toast to expose Undo')
  return onClick
}

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_A',
    availableSpaces: [{ id: 'SPACE_A', name: 'A', accent_color: null }],
    isReady: true,
  })
})

describe('usePageDeleteAction', () => {
  it('opens with default copy and accepts caller-specific button copy', async () => {
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page')
    })
    expect(await screen.findByRole('heading', { name: /^Delete page$/i })).toBeInTheDocument()
    expect(screen.getByText(/can be restored from trash/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be undone|permanently delete/i)).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: /^Cancel$/i }))
    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page', {
        confirmCopy: {
          titleKey: 'pageBrowser.deletePage',
          descriptionKey: 'pageHeader.deleteConfirm',
          confirmKey: 'pageBrowser.delete',
          cancelKey: 'pageBrowser.cancel',
          values: { name: 'My Page' },
        },
      })
    })

    expect(await screen.findByRole('heading', { name: 'Delete page?' })).toBeInTheDocument()
    expect(screen.getByText(/can be restored from trash/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be undone|permanently delete/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
  })

  it('uses the cached title on a successful delete and calls onDeleted once', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      }),
    })
    useResolveStore.getState().set('PAGE_1', 'Cached title', false)
    const onDeleted = vi.fn()
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible fallback', { onDeleted })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(onDeleted).toHaveBeenCalledWith('PAGE_1')
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Cached title',
      deleted: true,
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Page deleted',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    )
  })

  it('falls back to the visible title, then Undo restores status and calls onRestored', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      }),
      restore_blocks_by_ids: () => ({ affected_count: 1 }),
    })
    const onRestored = vi.fn()
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible title', { onRestored })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Visible title',
      deleted: true,
    })

    act(() => {
      lastUndoAction()()
    })

    await waitFor(() => expect(onRestored).toHaveBeenCalledWith('PAGE_1'))
    expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
      blockIds: ['PAGE_1'],
    })
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Visible title',
      deleted: false,
    })
  })

  it('keeps the page deleted and skips onRestored when Undo restore fails', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      }),
      restore_blocks_by_ids: () => Promise.reject(new Error('restore failed')),
    })
    const onRestored = vi.fn()
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Still deleted', { onRestored })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    act(() => {
      lastUndoAction()()
    })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to restore page'))
    expect(onRestored).not.toHaveBeenCalled()
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Still deleted',
      deleted: true,
    })
  })

  it('does not change resolve status or call onDeleted when delete fails', async () => {
    stubInvoke({ delete_block: () => Promise.reject(new Error('backend boom')) })
    useResolveStore.getState().set('PAGE_1', 'Original title', false)
    const onDeleted = vi.fn()
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Visible title', { onDeleted })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to delete page',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Retry' }) }),
      )
    })
    expect(onDeleted).not.toHaveBeenCalled()
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Original title',
      deleted: false,
    })
  })

  it('does not write an originating page into a newly active space', async () => {
    let resolveDelete: ((value: unknown) => void) | undefined
    stubInvoke({
      delete_block: () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    })
    useResolveStore.getState().set('PAGE_1', 'Space A title', false)
    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'Fallback')
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
    act(() => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
      resolveDelete?.({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      })
    })

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useResolveStore.getState().cache.has(keyFor('SPACE_B', 'PAGE_1'))).toBe(false)
    expect(useResolveStore.getState().cache.get(keyFor('SPACE_A', 'PAGE_1'))).toEqual({
      title: 'Space A title',
      deleted: false,
    })
  })

  // #4007 — the `[[` picker's page-name cache (`pagesListRef` in
  // `useBlockResolve`) is a React ref, not a store, so this flow can only
  // reach it through the name-change bus. Without these two emissions the
  // picker keeps offering a deleted page for the rest of the session (and,
  // after an Undo, keeps hiding a page that is back).
  it('broadcasts the delete — and the Undo — to the picker name caches', async () => {
    stubInvoke({
      delete_block: () => ({
        block_id: 'PAGE_1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      }),
      restore_blocks_by_ids: () => ({ affected_count: 1 }),
    })
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((change) => changes.push(change))
    try {
      const handle = renderHarness()
      act(() => {
        handle.api.requestDelete('PAGE_1', 'Doomed')
      })
      await userEvent.setup().click(await screen.findByRole('button', { name: /^Delete page$/i }))
      await waitFor(() => expect(toast.success).toHaveBeenCalled())

      expect(changes).toEqual([{ kind: 'removed', entity: 'page', id: 'PAGE_1' }])

      act(() => {
        lastUndoAction()()
      })
      await waitFor(() => expect(changes).toHaveLength(2))
      // A restore ADDS a row back, and the bus has no "added" event: an empty
      // cache means "not fetched yet", so inserting one row would latch a
      // one-row list as the whole space. Hence drop, not patch.
      expect(changes[1]).toEqual({ kind: 'invalidated' })
    } finally {
      unsubscribe()
    }
  })
})
