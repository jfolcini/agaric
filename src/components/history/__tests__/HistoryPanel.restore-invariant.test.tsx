/**
 * Tests for #1610 — HistoryPanel must OWN the restorability invariant.
 *
 * The production `BlockHistoryItem` withholds the restore affordance for
 * non-restorable rows (non-`edit_block` ops, or `edit_block` ops whose
 * payload lacks a string `to_text`). But `HistoryPanel` wires its single
 * `handleRestore` callback into EVERY row, so the guarantee that a
 * non-restorable row can't restore must NOT depend on the child withholding
 * the button — the handler itself has to guard.
 *
 * These tests mock `BlockHistoryItem` with a stub that ALWAYS renders a
 * restore button (regardless of restorability). That defeats the child's
 * invariant on purpose, isolating `HistoryPanel.handleRestore`'s own guard:
 *  - restorable entry → `edit_block` IPC fires, success toast shown.
 *  - non-restorable entry (wrong op_type) → NO mutation, error toast shown.
 *  - `edit_block` op with no `to_text` → NO mutation, error toast shown.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeHistoryEntry } from '@/__tests__/fixtures'
import { HistoryPanel } from '@/components/history/HistoryPanel'
import type { HistoryEntry } from '@/lib/tauri'

// Stub BlockHistoryItem: render a restore button for EVERY row, defeating the
// child's own "no affordance for non-restorable rows" invariant so the test
// exercises HistoryPanel's handler guard in isolation.
vi.mock('@/components/HistoryListItem', () => ({
  BlockHistoryItem: ({
    entry,
    index,
    onRestore,
  }: {
    entry: HistoryEntry
    index: number
    onRestore: (entry: HistoryEntry) => void
  }) => (
    <li data-testid={`stub-row-${index}`}>
      <span>{entry.op_type}</span>
      <button type="button" data-testid={`stub-restore-${index}`} onClick={() => onRestore(entry)}>
        Restore
      </button>
    </li>
  ),
}))

const mockedInvoke = vi.mocked(invoke)

function setupInvokeRouter(handlers: Record<string, (args: unknown) => unknown>) {
  mockedInvoke.mockImplementation((cmd: unknown, args?: unknown) => {
    const handler = handlers[cmd as string]
    if (!handler) return Promise.resolve(null)
    try {
      return Promise.resolve(handler(args))
    } catch (err) {
      return Promise.reject(err)
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryPanel restorability invariant (#1610)', () => {
  it('restores a restorable entry: editBlock fires + success toast', async () => {
    const user = userEvent.setup()
    setupInvokeRouter({
      get_block_history: () => ({
        items: [makeHistoryEntry(1, 'edit_block', { to_text: 'Old content' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Current text' }),
      edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Old content' }),
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'BLOCK001',
        toText: 'Old content',
      })
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Reverted successfully', expect.anything())
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('guards a non-restorable op_type: no editBlock, error toast surfaced', async () => {
    const user = userEvent.setup()
    setupInvokeRouter({
      get_block_history: () => ({
        // create_block is not restorable — yet the stubbed child renders a
        // restore button for it and calls onRestore directly.
        items: [makeHistoryEntry(1, 'create_block', { block_type: 'content' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Current text' }),
      edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'x' }),
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("This entry can't be restored")
    })
    // The mutation must NOT have been attempted.
    const editBlockCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'edit_block')
    expect(editBlockCalls).toHaveLength(0)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('guards an edit_block entry with no to_text: no editBlock, error toast surfaced', async () => {
    const user = userEvent.setup()
    setupInvokeRouter({
      get_block_history: () => ({
        items: [makeHistoryEntry(1, 'edit_block', { some_other_field: 'value' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      get_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'Current text' }),
      edit_block: () => ({ id: 'BLOCK001', block_type: 'content', content: 'x' }),
    })

    render(<HistoryPanel blockId="BLOCK001" />)

    const restoreBtn = await screen.findByTestId('stub-restore-0')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("This entry can't be restored")
    })
    const editBlockCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'edit_block')
    expect(editBlockCalls).toHaveLength(0)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
