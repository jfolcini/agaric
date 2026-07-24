/**
 * Tests for HistoryRevertDialog — error-path coverage (#1270).
 *
 * The dialog wraps the batch `revertOps` IPC. On rejection it must
 * surface the failure (toast via `reportIpcError`, aria-live announce)
 * rather than swallow it. These tests assert the error path fires on a
 * rejected IPC and that the happy path announces success.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HistoryRevertDialog } from '@/components/dialogs/HistoryRevertDialog'
import { announce } from '@/lib/announcer'
import type { HistoryEntry } from '@/lib/bindings'
import { notify } from '@/lib/notify'

const { mockRevert } = vi.hoisted(() => ({ mockRevert: vi.fn() }))

vi.mock('@/lib/bindings', () => ({
  commands: {
    revertOps: (...args: unknown[]) => mockRevert(...args),
  },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

const mockNotify = vi.mocked(notify)
const mockAnnounce = vi.mocked(announce)

const ENTRIES: HistoryEntry[] = [
  {
    device_id: 'dev-1',
    seq: 5,
    op_type: 'edit_block',
    payload: '{}',
    created_at: 1_735_689_600_000,
    is_replicated: false,
  },
  {
    device_id: 'dev-1',
    seq: 4,
    op_type: 'edit_block',
    payload: '{}',
    created_at: 1_735_689_500_000,
    is_replicated: false,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('HistoryRevertDialog', () => {
  it('confirming the revert fires revertOps and announces success', async () => {
    const user = userEvent.setup()
    mockRevert.mockResolvedValue(ok([]))
    const onSuccess = vi.fn()
    render(
      <HistoryRevertDialog
        open
        onOpenChange={vi.fn()}
        selectedEntries={ENTRIES}
        onSuccess={onSuccess}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Revert/i }))
    await waitFor(() => {
      expect(mockRevert).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalled()
    })
    expect(mockAnnounce).toHaveBeenCalled()
  })

  // #1270 error-path: a rejected revertOps IPC must surface a toast +
  // failure announce, not be swallowed.
  it('surfaces an error toast + announce when revertOps rejects', async () => {
    const user = userEvent.setup()
    mockRevert.mockRejectedValueOnce(new Error('ipc boom'))
    const onSuccess = vi.fn()
    render(
      <HistoryRevertDialog
        open
        onOpenChange={vi.fn()}
        selectedEntries={ENTRIES}
        onSuccess={onSuccess}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Revert/i }))
    await waitFor(() => {
      expect(mockNotify.error).toHaveBeenCalled()
    })
    expect(mockAnnounce).toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
