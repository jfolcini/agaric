/**
 * Tests for ActivityFeed — error-path coverage (#1270).
 *
 * The feed's per-entry Undo button (and per-session bulk revert) call
 * the `revertOps` IPC. On rejection the handler must surface a failure
 * toast (`notify.error`) and keep the entry's button available for
 * retry rather than swallow the error. These tests cover the rejected
 * single-entry undo plus the happy path.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityFeed } from '@/components/agent-access/ActivityFeed'
import type { ActivityEntry } from '@/hooks/useMcpActivityFeed'
import { notify } from '@/lib/notify'
import { revertOps } from '@/lib/tauri'

vi.mock('@/lib/tauri', () => ({
  revertOps: vi.fn(),
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const mockRevert = vi.mocked(revertOps)
const mockNotify = vi.mocked(notify)

// An agent-authored, successful RW entry with an opRef → the only
// shape that renders the per-entry Undo button.
const UNDOABLE: ActivityEntry = {
  toolName: 'edit_block',
  summary: 'Edited a block',
  timestamp: new Date().toISOString(),
  actorKind: 'agent',
  result: { kind: 'ok' },
  sessionId: 'sess-1',
  opRef: { device_id: 'dev-1', seq: 9 },
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ActivityFeed', () => {
  it('undoing an agent op fires revertOps and toasts success', async () => {
    const user = userEvent.setup()
    mockRevert.mockResolvedValue(undefined as never)
    render(<ActivityFeed entries={[UNDOABLE]} />)
    await user.click(screen.getByTestId('mcp-activity-undo'))
    await waitFor(() => {
      expect(mockRevert).toHaveBeenCalledWith({ ops: [UNDOABLE.opRef] })
      expect(mockNotify.success).toHaveBeenCalled()
    })
  })

  // #1270 error-path: a rejected revertOps must surface a failure
  // toast, not be swallowed.
  it('surfaces a failure toast when revertOps rejects', async () => {
    const user = userEvent.setup()
    mockRevert.mockRejectedValueOnce(new Error('ipc boom'))
    render(<ActivityFeed entries={[UNDOABLE]} />)
    await user.click(screen.getByTestId('mcp-activity-undo'))
    await waitFor(() => {
      expect(mockNotify.error).toHaveBeenCalled()
    })
    // The button stays available for retry — the success-terminal state
    // is NOT applied on failure.
    expect(screen.getByTestId('mcp-activity-undo')).toBeInTheDocument()
  })
})
