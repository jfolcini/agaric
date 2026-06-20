/**
 * Tests for HistoryRestoreDialog — error-path coverage (#1270).
 *
 * The dialog wraps the `restorePageToOp` IPC. On rejection it must
 * surface the failure (toast via `reportIpcError`, aria-live announce)
 * and NOT swallow it silently. These tests assert that error path
 * fires when the IPC rejects, and that the happy path notifies success.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HistoryRestoreDialog } from '@/components/dialogs/HistoryRestoreDialog'
import { announce } from '@/lib/announcer'
import { notify } from '@/lib/notify'
import { restorePageToOp } from '@/lib/tauri'
import type { HistoryEntry } from '@/lib/tauri'

vi.mock('@/lib/tauri', () => ({
  restorePageToOp: vi.fn(),
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

const mockRestore = vi.mocked(restorePageToOp)
const mockNotify = vi.mocked(notify)
const mockAnnounce = vi.mocked(announce)

const TARGET: HistoryEntry = {
  device_id: 'dev-1',
  seq: 7,
  op_type: 'edit_block',
  payload: '{}',
  created_at: 1_735_689_600_000,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('HistoryRestoreDialog', () => {
  it('confirming the restore fires restorePageToOp and toasts success', async () => {
    const user = userEvent.setup()
    mockRestore.mockResolvedValue({ ops_reverted: 3, non_reversible_skipped: 0 } as never)
    const onSuccess = vi.fn()
    render(
      <HistoryRestoreDialog
        open
        onOpenChange={vi.fn()}
        restoreTarget={TARGET}
        onSuccess={onSuccess}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Restore/i }))
    await waitFor(() => {
      expect(mockRestore).toHaveBeenCalledTimes(1)
      expect(mockNotify.success).toHaveBeenCalled()
      expect(onSuccess).toHaveBeenCalled()
    })
  })

  // #1270 error-path: a rejected restore IPC must surface a toast +
  // announce, not be swallowed.
  it('surfaces an error toast + announce when restorePageToOp rejects', async () => {
    const user = userEvent.setup()
    mockRestore.mockRejectedValueOnce(new Error('ipc boom'))
    const onSuccess = vi.fn()
    render(
      <HistoryRestoreDialog
        open
        onOpenChange={vi.fn()}
        restoreTarget={TARGET}
        onSuccess={onSuccess}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Restore/i }))
    await waitFor(() => {
      expect(mockNotify.error).toHaveBeenCalled()
    })
    // The failure-announce must fire and the success path must not run.
    expect(mockAnnounce).toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
