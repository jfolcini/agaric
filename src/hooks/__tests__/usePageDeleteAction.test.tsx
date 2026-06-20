/**
 * Tests for usePageDeleteAction hook (Part A).
 *
 * Validates:
 *  - `requestDelete()` opens the ConfirmDialog (dialog mount appears in DOM).
 *  - On confirm: `delete_block` invoked once with the pageId.
 *  - Success toast carries an "Undo" action that calls
 *    `restore_blocks_by_ids` with `[pageId]`.
 *  - `onDeleted` callback fires once after a successful delete.
 *  - Custom `confirmCopy` (used by the journal day header) overrides
 *    the default title/description.
 *  - Failure path surfaces an error toast with a "Retry" action.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePageDeleteAction } from '../usePageDeleteAction'

const mockedInvoke = vi.mocked(invoke)

/** Tiny harness that exposes the hook return on `window` for direct assertions. */
function Harness({ onReady }: { onReady: (api: ReturnType<typeof usePageDeleteAction>) => void }) {
  const api = usePageDeleteAction()
  onReady(api)
  return <>{api.confirmDialog}</>
}

function renderHarness(): { api: ReturnType<typeof usePageDeleteAction> } {
  // Mutable holder — the harness assigns the latest snapshot on every render.
  const holder: { api: ReturnType<typeof usePageDeleteAction> | null } = { api: null }
  const onReady = (api: ReturnType<typeof usePageDeleteAction>) => {
    holder.api = api
  }
  render(<Harness onReady={onReady} />)
  if (!holder.api) throw new Error('Harness did not yield an api')
  return holder as { api: ReturnType<typeof usePageDeleteAction> }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePageDeleteAction', () => {
  it('opens the confirm dialog with default copy when requestDelete is called', async () => {
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page')
    })

    // Dialog renders the default page-delete copy. "Delete page" also
    // appears as the action-button label, so scope to the heading.
    expect(await screen.findByRole('heading', { name: /^Delete page$/i })).toBeInTheDocument()
    expect(
      screen.getByText(
        'This action cannot be undone. This will permanently delete the page and all its blocks.',
      ),
    ).toBeInTheDocument()
  })

  it('overrides title + description when confirmCopy is supplied', async () => {
    const handle = renderHarness()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'Sun, Jun 15, 2025', {
        confirmCopy: {
          title: 'Delete the note for Sun, Jun 15, 2025?',
          description: 'This moves the day note to Trash.',
        },
      })
    })

    expect(
      await screen.findByRole('heading', { name: /Delete the note for Sun, Jun 15, 2025\?/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('This moves the day note to Trash.')).toBeInTheDocument()
  })

  it('confirm runs delete_block + fires success toast with Undo action', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue({
      block_id: 'PAGE_1',
      deleted_at: '2026-01-01T00:00:00Z',
      descendants_affected: 0,
    })

    const handle = renderHarness()
    const onDeleted = vi.fn()

    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page', { onDeleted })
    })

    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    // The IPC should have been called exactly with the page id.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'PAGE_1' })
    })

    // Success toast was raised with an "Undo" action.
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Page deleted',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      )
    })

    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith('PAGE_1')
  })

  it('clicking the Undo toast action restores via restore_blocks_by_ids', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue({
      block_id: 'PAGE_1',
      deleted_at: '2026-01-01T00:00:00Z',
      descendants_affected: 0,
    })

    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page')
    })
    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })

    // Pull the action handler out of the success-toast call and invoke it.
    // `notify.success(message, opts)` forwards `opts` straight through to
    // `toast.success`, so the action handler we passed in the hook is the
    // function we want to invoke here.
    const successCalls = vi.mocked(toast.success).mock.calls
    const lastCall = successCalls.at(-1)
    const opts = lastCall?.[1] as { action: { onClick: () => void } } | undefined
    expect(opts?.action?.onClick).toBeTypeOf('function')

    // Now invoke Undo. It must call restore_blocks_by_ids with [pageId].
    // Reset the invoke spy so we can assert it was called exactly once for
    // the restore (not counting the delete above).
    mockedInvoke.mockClear()
    mockedInvoke.mockResolvedValue({ affected_count: 1 })

    act(() => {
      opts?.action?.onClick()
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
        blockIds: ['PAGE_1'],
      })
    })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error toast with a Retry action when delete fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValueOnce(new Error('backend boom'))

    const handle = renderHarness()
    act(() => {
      handle.api.requestDelete('PAGE_1', 'My Page')
    })
    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to delete page',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Retry' }),
        }),
      )
    })
  })
})
