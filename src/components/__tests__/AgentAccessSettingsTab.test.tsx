/**
 * Tests for AgentAccessSettingsTab — FEAT-4e/FEAT-4h Settings tab.
 *
 * Validates:
 *  - Renders the happy-path layout (RO toggle, socket path, copy
 *    buttons, activity empty state, kill switch, RW toggle, RW socket
 *    path, RW kill switch).
 *  - RO toggle on/off roundtrips through `invoke('mcp_set_enabled', …)`.
 *  - RW toggle on/off roundtrips through `invoke('mcp_rw_set_enabled',
 *    …)`.
 *  - Copy buttons write the correct JSON/path to the clipboard.
 *  - Destructive warning badge appears only while the RW socket is
 *    enabled.
 *  - RO / RW kill switches fire their respective `*_disconnect_all`
 *    commands after confirming the dialog.
 *  - Activity feed subscribes to `mcp:activity`, renders incoming
 *    entries newest-first, and caps the rendered rows at 100.
 *  - IPC rejection on every mocked invoke: component logs via
 *    `logger.warn` / `logger.error`, does not crash, and shows a toast
 *    error + degraded fallback.
 *  - Graceful fallback when only one of the RO / RW status loads
 *    succeeds.
 *  - `axe(container)` a11y audit returns zero violations.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { AgentAccessSettingsTab } from '../AgentAccessSettingsTab'

// ---------------------------------------------------------------------------
// Tauri event mock — every test registers its listener here and can fire
// arbitrary `mcp:activity` events via `fireActivityEvent`.
// ---------------------------------------------------------------------------

type EventHandler = (event: { payload: unknown }) => void
const eventListeners = new Map<string, EventHandler>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: EventHandler) => {
    eventListeners.set(name, handler)
    return () => {
      eventListeners.delete(name)
    }
  }),
}))

function fireActivityEvent(payload: unknown) {
  const handler = eventListeners.get('mcp:activity')
  if (handler) {
    handler({ payload })
  }
}

// ---------------------------------------------------------------------------
// Logger spy — exercises the error-path logging without suppressing
// console output in other tests (the mock replaces the logger module).
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Clipboard wrapper mock — `AgentAccessSettingsTab` calls
// `writeText(text)` from `@/lib/clipboard` (the Tauri clipboard-manager
// plugin wrapper), not `navigator.clipboard.writeText` directly. Mocking
// the wrapper here lets us assert on the call and force rejection paths
// without wrestling with `userEvent.setup()`'s built-in jsdom clipboard
// stub. Matches the pattern used by `BugReportDialog.test.tsx`.
// ---------------------------------------------------------------------------

vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

const clipboardWriteText = vi.mocked(writeText)

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
const mockedLoggerError = vi.mocked(logger.error)
const mockedLoggerWarn = vi.mocked(logger.warn)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface McpStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

interface McpRwStatus {
  enabled: boolean
  socket_path: string
  active_connections: number
}

function makeStatus(overrides: Partial<McpStatus> = {}): McpStatus {
  return {
    enabled: false,
    socket_path: '/home/test/.local/share/com.agaric.app/mcp-ro.sock',
    active_connections: 0,
    ...overrides,
  }
}

function makeRwStatus(overrides: Partial<McpRwStatus> = {}): McpRwStatus {
  return {
    enabled: false,
    socket_path: '/home/test/.local/share/com.agaric.app/mcp-rw.sock',
    active_connections: 0,
    ...overrides,
  }
}

/**
 * Mirrors the production `ActivityEntry` shape (wire payload emitted on
 * `mcp:activity`).  Includes the FEAT-4h slice 3 additions:
 *   - `sessionId` — required per-connection ULID
 *   - `opRef` — optional snake_case OpRef populated only for RW + ok
 *
 * Factory defaults match the most common fixture (agent + ok + opRef
 * present) so FEAT-4h slice 3 tests read cleanly; overrides let tests
 * flip `actorKind` / `result` / `opRef` with one line.
 */
interface ActivityEntryFixture {
  toolName: string
  summary: string
  timestamp: string
  actorKind: 'user' | 'agent'
  agentName?: string | undefined
  result: { kind: 'ok' } | { kind: 'err'; message: string }
  sessionId: string
  opRef?: { device_id: string; seq: number } | undefined
}

function makeActivityEntry(overrides: Partial<ActivityEntryFixture> = {}): ActivityEntryFixture {
  return {
    toolName: 'create_block',
    summary: 'created 1 block',
    timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
    actorKind: 'agent',
    agentName: 'claude-desktop',
    result: { kind: 'ok' },
    sessionId: 'SESSION_TEST',
    opRef: { device_id: 'D', seq: 1 },
    ...overrides,
  }
}

/**
 * Default invoke mock: every RO + RW MCP command resolves to a sensible
 * default so re-fetches after toggles / disconnect succeed without
 * per-test re-mocking.
 */
function setupInvoke(status: McpStatus = makeStatus(), rwStatus: McpRwStatus = makeRwStatus()) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_mcp_status') return status
    if (cmd === 'mcp_set_enabled') return true
    if (cmd === 'mcp_disconnect_all') return null
    if (cmd === 'get_mcp_socket_path') return status.socket_path
    if (cmd === 'get_mcp_rw_status') return rwStatus
    if (cmd === 'mcp_rw_set_enabled') return true
    if (cmd === 'mcp_rw_disconnect_all') return null
    if (cmd === 'get_mcp_rw_socket_path') return rwStatus.socket_path
    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  // Re-arm the wrapper mock — `vi.clearAllMocks()` wipes the default
  // resolution installed at module load.
  clipboardWriteText.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Happy-path rendering
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — rendering', () => {
  it('renders every section once the status loads', async () => {
    setupInvoke(makeStatus({ enabled: true, active_connections: 0 }))

    render(<AgentAccessSettingsTab />)

    // Section headings
    expect(await screen.findByText('Agent access')).toBeInTheDocument()
    expect(screen.getByText('Read-only access')).toBeInTheDocument()
    expect(screen.getByText('Socket path')).toBeInTheDocument()
    expect(screen.getByText('Agent configuration')).toBeInTheDocument()
    expect(screen.getByText('Recent activity')).toBeInTheDocument()
    expect(screen.getByText('Connections')).toBeInTheDocument()
    expect(screen.getByText('Read-write access')).toBeInTheDocument()
    expect(screen.getByText('Read-write socket path')).toBeInTheDocument()
    expect(screen.getByText('Read-write connections')).toBeInTheDocument()

    // RO socket path is displayed as-is
    expect(screen.getByTestId('mcp-socket-path')).toHaveTextContent(
      '/home/test/.local/share/com.agaric.app/mcp-ro.sock',
    )
    // RW socket path is a separate code block
    expect(screen.getByTestId('mcp-rw-socket-path')).toHaveTextContent(
      '/home/test/.local/share/com.agaric.app/mcp-rw.sock',
    )

    // Copy buttons visible (RO-only — RW config copy is out of scope)
    expect(screen.getByRole('button', { name: /Copy Claude Desktop config/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy generic MCP config/i })).toBeInTheDocument()

    // Retired placeholder — "Coming in v2" must no longer render.
    expect(screen.queryByText('Coming in v2')).not.toBeInTheDocument()

    // Kill switches read zero active
    expect(screen.getByText(/No active connections\./)).toBeInTheDocument()
    expect(screen.getByText(/No active read-write connections\./)).toBeInTheDocument()
  })

  it('renders loading skeleton before status loads', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
    const { container } = render(<AgentAccessSettingsTab />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('has no axe violations', async () => {
    setupInvoke(
      makeStatus({ enabled: true, active_connections: 2 }),
      makeRwStatus({ enabled: true, active_connections: 1 }),
    )
    const { container } = render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')
    // axe cold-load can exceed 1 s under worker contention.
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// ---------------------------------------------------------------------------
// Toggle — RO access
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — RO toggle', () => {
  it('invokes mcp_set_enabled(true) when toggled on', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ enabled: false }))

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-only access' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_set_enabled', { enabled: true })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Read-only agent access enabled')
  })

  it('invokes mcp_set_enabled(false) when toggled off', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ enabled: true }))

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-only access' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_set_enabled', { enabled: false })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Read-only agent access disabled')
  })

  it('rolls back the toggle on IPC rejection and logs the error', async () => {
    const user = userEvent.setup()
    // First call: status load. Second call: mcp_set_enabled rejects.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus({ enabled: false })
      if (cmd === 'get_mcp_rw_status') return makeRwStatus({ enabled: false })
      if (cmd === 'mcp_set_enabled') throw new Error('backend exploded')
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-only access' })
    await user.click(toggle)

    // Optimistic update flipped it on; rollback flips it back off.
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to set MCP enabled',
      { enabled: true },
      expect.any(Error),
    )
    expect(mockedToastError).toHaveBeenCalledWith('Failed to toggle agent access')
  })
})

// ---------------------------------------------------------------------------
// Toggle — RW access
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — RW toggle', () => {
  it('invokes mcp_rw_set_enabled(true) when toggled on', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus(), makeRwStatus({ enabled: false }))

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-write access' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_rw_set_enabled', { enabled: true })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Read-write agent access enabled')
    // Note: after the success path, `loadStatus()` re-fires and the
    // switch re-syncs to whatever the backend reports. We don't assert
    // aria-checked here since the mocked status is immutable across
    // toggles — the invoke + toast assertions cover the user intent.
  })

  it('invokes mcp_rw_set_enabled(false) when toggled off', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus(), makeRwStatus({ enabled: true }))

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-write access' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_rw_set_enabled', { enabled: false })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Read-write agent access disabled')
  })

  it('rolls back the RW toggle on IPC rejection and logs the error', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus({ enabled: false })
      if (cmd === 'get_mcp_rw_status') return makeRwStatus({ enabled: false })
      if (cmd === 'mcp_rw_set_enabled') throw new Error('rw backend exploded')
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    const toggle = await screen.findByRole('switch', { name: 'Read-write access' })
    await user.click(toggle)

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to set MCP RW enabled',
      { enabled: true },
      expect.any(Error),
    )
    expect(mockedToastError).toHaveBeenCalledWith('Failed to toggle agent access')
  })
})

// ---------------------------------------------------------------------------
// Destructive warning badge (RW only)
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — RW warning badge', () => {
  it('renders the destructive warning badge while RW is enabled', async () => {
    setupInvoke(makeStatus(), makeRwStatus({ enabled: true }))
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-write access')

    const badge = await screen.findByTestId('mcp-rw-warning-badge')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Agents can create, edit, and delete blocks while this is on.')
    expect(badge).toHaveAttribute('data-variant', 'destructive')
  })

  it('does not render the warning badge when RW is disabled', async () => {
    setupInvoke(makeStatus(), makeRwStatus({ enabled: false }))
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-write access')

    expect(screen.queryByTestId('mcp-rw-warning-badge')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Copy-config buttons
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — copy buttons', () => {
  it('copies the socket path to the clipboard', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())

    render(<AgentAccessSettingsTab />)
    const copyBtn = await screen.findByRole('button', { name: 'Copy socket path' })
    await user.click(copyBtn)

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        '/home/test/.local/share/com.agaric.app/mcp-ro.sock',
      )
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Socket path copied')
  })

  it('copies the RW socket path to the clipboard', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus(), makeRwStatus())

    render(<AgentAccessSettingsTab />)
    const copyBtn = await screen.findByRole('button', { name: 'Copy read-write socket path' })
    await user.click(copyBtn)

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        '/home/test/.local/share/com.agaric.app/mcp-rw.sock',
      )
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Read-write socket path copied')
  })

  it('copies the Claude Desktop config as valid JSON', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: /Copy Claude Desktop config/i })
    await user.click(btn)

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    })
    const written = clipboardWriteText.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(written)
    expect(parsed).toEqual({
      mcpServers: {
        agaric: {
          command: 'agaric-mcp',
          env: { AGARIC_MCP_SOCKET: '/home/test/.local/share/com.agaric.app/mcp-ro.sock' },
        },
      },
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Claude Desktop config copied')
  })

  it('copies the generic MCP config as valid JSON', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: /Copy generic MCP config/i })
    await user.click(btn)

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    })
    const written = clipboardWriteText.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(written)
    expect(parsed).toEqual({
      command: 'agaric-mcp',
      env: { AGARIC_MCP_SOCKET: '/home/test/.local/share/com.agaric.app/mcp-ro.sock' },
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Generic MCP config copied')
  })

  it('logs and toasts on clipboard failure', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: /Copy Claude Desktop config/i })
    // Override the clipboard writeText just for this test to reject.
    clipboardWriteText.mockRejectedValueOnce(new Error('clipboard blocked'))
    await user.click(btn)

    await waitFor(() => {
      expect(mockedLoggerWarn).toHaveBeenCalledWith(
        'AgentAccessSettingsTab',
        'clipboard write failed',
        undefined,
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to copy to clipboard')
  })
})

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — activity feed', () => {
  it('renders the empty state when no activity has arrived', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    expect(
      await screen.findByText(
        /No agent activity yet\. When an agent connects, tool calls appear here\./,
      ),
    ).toBeInTheDocument()
  })

  it('prepends incoming events to the rendered feed (newest first)', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent({
        toolName: 'search',
        summary: 'searched for "foo" (3 results)',
        timestamp: new Date().toISOString(),
        actorKind: 'agent',
        agentName: 'claude-desktop',
        result: { kind: 'ok' },
        sessionId: 'SESSION_TEST',
        opRef: undefined,
      })
    })
    act(() => {
      fireActivityEvent({
        toolName: 'get_block',
        summary: 'fetched 1 block',
        timestamp: new Date().toISOString(),
        actorKind: 'agent',
        agentName: 'claude-desktop',
        result: { kind: 'ok' },
        sessionId: 'SESSION_TEST',
        opRef: undefined,
      })
    })

    const rows = await screen.findAllByTestId('mcp-activity-row')
    expect(rows).toHaveLength(2)
    // Newest first: second event pushed is at index 0.
    expect(rows[0]).toHaveTextContent('get_block')
    expect(rows[0]).toHaveTextContent('fetched 1 block')
    expect(rows[1]).toHaveTextContent('search')
    expect(rows[1]).toHaveTextContent('searched for "foo"')
  })

  it('caps rendered rows at 100 (101st push drops the oldest)', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      for (let i = 0; i < 101; i++) {
        fireActivityEvent({
          toolName: 'search',
          summary: `call #${i}`,
          timestamp: new Date(2024, 0, 1, 0, 0, i).toISOString(),
          actorKind: 'agent',
          agentName: 'test',
          result: { kind: 'ok' },
          sessionId: 'SESSION_TEST',
          opRef: undefined,
        })
      }
    })

    const rows = await screen.findAllByTestId('mcp-activity-row')
    // Exact-count assertion per AGENTS.md §Testing Conventions.
    expect(rows).toHaveLength(100)
    // The newest entry (#100) is at the top.
    expect(rows[0]).toHaveTextContent('call #100')
    // The oldest survivor is #1 (call #0 was evicted).
    expect(rows[99]).toHaveTextContent('call #1')
  })

  it('shows error-result summaries in destructive color', async () => {
    setupInvoke(makeStatus())
    const { container } = render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent({
        toolName: 'search',
        summary: 'search failed: invalid query',
        timestamp: new Date().toISOString(),
        actorKind: 'agent',
        agentName: 'test',
        result: { kind: 'err', message: 'invalid query' },
        sessionId: 'SESSION_TEST',
        opRef: undefined,
      })
    })

    const row = await screen.findByTestId('mcp-activity-row')
    // Destructive text class applied to the summary span.
    expect(row.querySelector('.text-destructive')).not.toBeNull()
    expect(container).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FEAT-4h slice 3 — per-entry Undo button on agent-authored RW rows.
// Visibility rules (button renders iff all three hold):
//   - actorKind === 'agent'
//   - result.kind === 'ok'
//   - opRef != null
// Click handler delegates to `revert_ops` with a single OpRef; loading
// state is keyed by `${device_id}:${seq}` and swaps the button to a
// spinner while the IPC call is in flight.  NonReversible errors get a
// dedicated toast; every other error falls through to the generic one.
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — undo agent op', () => {
  const undoLabel = 'Undo this agent action'

  it('renders the undo button on an agent-authored RW activity row', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          actorKind: 'agent',
          result: { kind: 'ok' },
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
    })

    expect(await screen.findByLabelText(undoLabel)).toBeInTheDocument()
  })

  it('hides the undo button on a user-authored activity row', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          actorKind: 'user',
          result: { kind: 'ok' },
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
    })

    // Wait for the row to render before asserting absence of the button.
    await screen.findByTestId('mcp-activity-row')
    expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
  })

  it('hides the undo button on a failed agent activity row', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          actorKind: 'agent',
          result: { kind: 'err', message: 'validation failed' },
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
    })

    await screen.findByTestId('mcp-activity-row')
    expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
  })

  it('hides the undo button when opRef is missing (e.g. RO tool)', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'search',
          actorKind: 'agent',
          result: { kind: 'ok' },
          opRef: undefined,
        }),
      )
    })

    await screen.findByTestId('mcp-activity-row')
    expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
  })

  it('invokes revert_ops with the correct OpRef and fires a success toast', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 1 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('revert_ops', {
        ops: [{ device_id: 'D', seq: 1 }],
      })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Agent action undone')
  })

  it('shows a spinner and disables the button while the revert is in flight', async () => {
    const user = userEvent.setup()
    // Deferred promise so the undo never resolves until we explicitly
    // resolve it — lets us observe the loading state.
    let resolveRevert: ((value: unknown) => void) | undefined
    const revertPromise = new Promise((r) => {
      resolveRevert = r
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') return revertPromise
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 42 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'false')

    await user.click(btn)

    await waitFor(() => {
      expect(btn).toBeDisabled()
    })
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(btn.querySelector('[data-slot="spinner"]')).not.toBeNull()

    // Resolve the pending invoke — UX-252: a successful revert marks
    // this opRef terminal-success so the per-entry Undo button drops
    // out of the DOM entirely (instead of re-enabling). The entry row
    // itself stays rendered — only the action affordance vanishes.
    await act(async () => {
      resolveRevert?.(undefined)
      await revertPromise
    })

    await waitFor(() => {
      expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
    })
    // The activity row for this entry is still rendered.
    expect(screen.getByTestId('mcp-activity-row')).toBeInTheDocument()
  })

  it('logs and toasts a generic failure when revert_ops rejects with a non-NonReversible error', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') {
        // Mirror the `AppError::Database` wire shape from
        // src-tauri/src/error.rs — `{ kind, message }` carried on an
        // Error instance so biome's useThrowOnlyError is satisfied.
        throw Object.assign(new Error('disk full'), { kind: 'database' })
      }
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 7 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'AgentAccessSettingsTab',
        'undo failed',
        { opRef: { device_id: 'D', seq: 7 } },
        expect.objectContaining({ kind: 'database' }),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Could not undo agent action')
    // Button is re-enabled after the error settles.
    await waitFor(() => {
      expect(btn).not.toBeDisabled()
    })
  })

  it('fires the non-reversible toast when revert_ops rejects with kind=non_reversible', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') {
        // Matches the `AppError::NonReversible` serialization from
        // src-tauri/src/error.rs — `{ kind, message }` shape with
        // `kind === 'non_reversible'`, carried on an Error instance
        // so biome's useThrowOnlyError is satisfied.
        throw Object.assign(new Error('Non-reversible operation: purge_block cannot be undone'), {
          kind: 'non_reversible',
        })
      }
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 9 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('This agent action cannot be undone')
    })
    // Generic failure toast must not fire — dedicated branch only.
    expect(mockedToastError).not.toHaveBeenCalledWith('Could not undo agent action')
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'undo failed',
      { opRef: { device_id: 'D', seq: 9 } },
      expect.objectContaining({ kind: 'non_reversible' }),
    )
  })

  it('has no axe violations with a mixed agent/user/ok/err activity feed', async () => {
    setupInvoke(makeStatus())
    const { container } = render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      // 1. Agent + ok + opRef → undo button visible.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'created 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      // 2. Agent + ok + no opRef (RO tool) → no undo.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'search',
          summary: 'searched for "foo"',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          opRef: undefined,
        }),
      )
      // 3. Agent + err → no undo.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          summary: 'edit failed',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          result: { kind: 'err', message: 'bad content' },
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      // 4. User + ok → no undo (user-authored, no agent action to revert).
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'user created 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 4).toISOString(),
          actorKind: 'user',
          agentName: undefined,
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
      // 5. Agent + ok + opRef → undo button visible.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          summary: 'set property foo=bar',
          timestamp: new Date(2024, 0, 1, 0, 0, 5).toISOString(),
          opRef: { device_id: 'D', seq: 4 },
        }),
      )
    })

    const rows = await screen.findAllByTestId('mcp-activity-row')
    expect(rows).toHaveLength(5)
    // Exactly two undo buttons (fixtures 1 and 5).
    expect(screen.getAllByLabelText('Undo this agent action')).toHaveLength(2)

    // axe cold-load can exceed 1 s under worker contention.  Wrap in
    // `waitFor` with a raised timeout and an outer per-test timeout
    // that leaves headroom (AGENTS.md §axe cold-load).
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 8000 },
    )
  }, 15000)
})

// ---------------------------------------------------------------------------
// FEAT-4h slice 4 — per-session bulk-revert on the activity feed.
//
// A session header renders on the first-seen entry (newest-first) of
// each session that has ≥ 2 undoable ops.  The header carries a
// "Revert session" button that opens a confirm dialog with the exact
// opRefs snapshotted at click time; confirming fires `revert_ops`
// once with the full batch.  Failure paths mirror the per-entry Undo
// error handling (generic failure vs NonReversible).
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — revert session', () => {
  const revertSessionLabelExact3 = 'Revert this agent session (3 actions)'
  const revertSessionLabelExact2 = 'Revert this agent session (2 actions)'

  it('renders a session header on the first-seen entry when the session has ≥ 2 undoable ops', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'created 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          summary: 'edited 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          summary: 'set property foo=bar',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    const headers = await screen.findAllByTestId('mcp-activity-session-header')
    expect(headers).toHaveLength(1)
    // Header's VISIBLE text is the short pluralized count — distinct from
    // the button's aria-label so screen-reader users and sighted users
    // get non-duplicate information.
    expect(headers[0]).toHaveTextContent('3 agent actions')
    expect(headers[0]).not.toHaveTextContent('Revert this agent session')
    // Revert-session button renders inside the header with the
    // "Revert session" button text + the full aria-label for
    // screen readers.
    const revertBtn = within(headers[0] as HTMLElement).getByTestId('mcp-activity-revert-session')
    expect(revertBtn).toHaveTextContent('Revert session')
    expect(revertBtn).toHaveAttribute('aria-label', revertSessionLabelExact3)
  })

  it('does NOT render a session header when the session has only 1 undoable op', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          sessionId: 'SESSION_SINGLE',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
    })

    // Row renders but no session header appears.
    await screen.findByTestId('mcp-activity-row')
    expect(screen.queryByTestId('mcp-activity-session-header')).not.toBeInTheDocument()
    // Per-entry Undo button is still present (slice 3 behaviour).
    expect(screen.getByLabelText('Undo this agent action')).toBeInTheDocument()
  })

  it('does NOT render a session header on non-first-seen entries of the same session', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    // Three rows, exactly one header — rendered on the first-seen
    // entry (newest, i.e. set_property at the top of the feed).
    const rows = await screen.findAllByTestId('mcp-activity-row')
    expect(rows).toHaveLength(3)
    const headers = screen.getAllByTestId('mcp-activity-session-header')
    expect(headers).toHaveLength(1)
  })

  it('renders separate session headers when two sessions are interleaved', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      // A1, B1, A2, B2 — both sessions end up with 2 undoable ops each.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_ALPHA',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_BETA',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_ALPHA',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 4).toISOString(),
          sessionId: 'SESSION_BETA',
          opRef: { device_id: 'D', seq: 4 },
        }),
      )
    })

    await screen.findAllByTestId('mcp-activity-row')
    const headers = screen.getAllByTestId('mcp-activity-session-header')
    expect(headers).toHaveLength(2)
    const sessionIds = headers.map((h) => h.getAttribute('data-session-id')).sort()
    expect(sessionIds).toEqual(['SESSION_ALPHA', 'SESSION_BETA'])
  })

  it('ignores user-authored and failed entries when counting session ops', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      // 1 agent + ok + opRef (counts)
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_X',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      // 1 user + ok + opRef (excluded — user-authored)
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          actorKind: 'user',
          agentName: undefined,
          sessionId: 'SESSION_X',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      // 1 agent + err + opRef (excluded — failure)
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_X',
          result: { kind: 'err', message: 'invalid content' },
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    // Total session-X undoable ops = 1 → header hidden.
    await screen.findAllByTestId('mcp-activity-row')
    expect(screen.queryByTestId('mcp-activity-session-header')).not.toBeInTheDocument()
  })

  it('clicking Revert session opens the confirm dialog with the correct count', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    const revertBtn = await screen.findByTestId('mcp-activity-revert-session')
    await user.click(revertBtn)

    const confirm = await screen.findByRole('alertdialog')
    // Title + plural description both include the snapshotted count.
    expect(within(confirm).getByText('Revert session?')).toBeInTheDocument()
    expect(
      within(confirm).getByText('This will undo 3 agent actions in this session. Continue?'),
    ).toBeInTheDocument()
  })

  it('confirming invokes revert_ops with every undoable opRef in the session in iteration order', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    // Fire events in seq order 1, 2, 3 — feed is newest-first so
    // entries.map walks [seq=3, seq=2, seq=1], and undoableBySession
    // buckets in that walk order.  Expected ops payload is the same
    // newest-first sequence.
    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    const revertBtn = await screen.findByTestId('mcp-activity-revert-session')
    await user.click(revertBtn)

    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', { name: 'Revert session' })
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('revert_ops', {
        ops: [
          { device_id: 'D', seq: 3 },
          { device_id: 'D', seq: 2 },
          { device_id: 'D', seq: 1 },
        ],
      })
    })
    // Exact count assertion — exactly one revert_ops call with 3 ops.
    const revertCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'revert_ops')
    expect(revertCalls).toHaveLength(1)
    const payload = revertCalls[0]?.[1] as { ops: unknown[] }
    expect(payload.ops).toHaveLength(3)
    expect(mockedToastSuccess).toHaveBeenCalledWith('Session reverted (3 actions)')
  })

  it('cancelling the confirm dialog does NOT invoke revert_ops', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
    })

    const revertBtn = await screen.findByTestId('mcp-activity-revert-session')
    await user.click(revertBtn)

    const confirm = await screen.findByRole('alertdialog')
    const cancelBtn = await within(confirm).findByRole('button', { name: /cancel/i })
    await user.click(cancelBtn)

    // Dialog closes.
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    // revert_ops was never invoked.
    const revertCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'revert_ops')
    expect(revertCalls).toHaveLength(0)
    // Sanity — plural label still matches the 2-op session.
    expect(revertBtn).toHaveAttribute('aria-label', revertSessionLabelExact2)
  })

  it('fires the session-specific nonReversible toast when revert_ops rejects with kind=non_reversible', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') {
        throw Object.assign(new Error('Non-reversible: purge_block cannot be undone'), {
          kind: 'non_reversible',
        })
      }
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
    })

    const revertBtn = await screen.findByTestId('mcp-activity-revert-session')
    await user.click(revertBtn)
    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', { name: 'Revert session' })
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'One or more actions in this session cannot be undone',
      )
    })
    // Session-specific error — not the per-entry wording.
    expect(mockedToastError).not.toHaveBeenCalledWith('This agent action cannot be undone')
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'revert session failed',
      { sessionId: 'SESSION_A', opCount: 2 },
      expect.objectContaining({ kind: 'non_reversible' }),
    )
  })

  it('has no axe violations on a session-grouped feed', async () => {
    setupInvoke(makeStatus())
    const { container } = render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      // Session A — 2 undoable ops (header shown).
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'created 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          summary: 'edited 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_A',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      // Session B — user-authored, excluded from header.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'user created 1 block',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          actorKind: 'user',
          agentName: undefined,
          sessionId: 'SESSION_B',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
      // Session C — 1 ok + 1 err, only 1 undoable so no header.
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          summary: 'set property foo=bar',
          timestamp: new Date(2024, 0, 1, 0, 0, 4).toISOString(),
          sessionId: 'SESSION_C',
          opRef: { device_id: 'D', seq: 4 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          summary: 'edit failed',
          timestamp: new Date(2024, 0, 1, 0, 0, 5).toISOString(),
          sessionId: 'SESSION_C',
          result: { kind: 'err', message: 'validation failed' },
          opRef: { device_id: 'D', seq: 5 },
        }),
      )
    })

    const rows = await screen.findAllByTestId('mcp-activity-row')
    expect(rows).toHaveLength(5)
    const headers = screen.getAllByTestId('mcp-activity-session-header')
    expect(headers).toHaveLength(1)

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 8000 },
    )
  }, 15000)
})

// ---------------------------------------------------------------------------
// UX-252 — terminal-state tracking for successfully-reverted opRefs.
//
// A successful per-entry Undo OR per-session bulk revert adds every
// reverted opRef's `${device_id}:${seq}` key to an in-component
// `revertedOpKeys` Set.  The per-entry Undo button visibility
// predicate + the `undoableBySession` memo both filter against that
// set, so after a successful revert the action affordances disappear
// from the DOM — preventing a user who missed the toast from
// double-clicking and triggering unexpected backend toggle
// behaviour.  On error no keys are added, so the user can retry.
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — revertedOpKeys tracking (UX-252)', () => {
  const undoLabel = 'Undo this agent action'

  it('hides the per-entry Undo button after a successful revert', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 1 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    // Wait for the success toast to fire — flush state updates.
    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalledWith('Agent action undone')
    })
    // Button disappears from the DOM; the entry row itself stays.
    await waitFor(() => {
      expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
    })
  })

  it('keeps the entry summary / timestamp / toolName badge after a successful revert', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          summary: 'created 1 block',
          timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    await waitFor(() => {
      expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
    })

    // Only the action affordance disappeared — the row content stays.
    const row = screen.getByTestId('mcp-activity-row')
    expect(within(row).getByText('create_block')).toBeInTheDocument()
    expect(within(row).getByText('created 1 block')).toBeInTheDocument()
    const time = row.querySelector('time')
    expect(time).not.toBeNull()
    expect(time).toHaveAttribute('dateTime', '2024-01-01T00:00:00.000Z')
  })

  it('hides the session header after a successful per-session revert', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_BULK',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_BULK',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'set_property',
          timestamp: new Date(2024, 0, 1, 0, 0, 3).toISOString(),
          sessionId: 'SESSION_BULK',
          opRef: { device_id: 'D', seq: 3 },
        }),
      )
    })

    // Header renders — 3 undoable ops in SESSION_BULK.
    const revertBtn = await screen.findByTestId('mcp-activity-revert-session')
    await user.click(revertBtn)

    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', { name: 'Revert session' })
    await user.click(actionBtn)

    // Wait for the success toast to fire — flush state updates.
    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalledWith('Session reverted (3 actions)')
    })

    // Every opRef in the session is now in `revertedOpKeys`;
    // `undoableBySession.get(SESSION_BULK)` is empty → header gate
    // `sessionOps.length >= 2` fails and the header vanishes.
    await waitFor(() => {
      expect(screen.queryByTestId('mcp-activity-session-header')).not.toBeInTheDocument()
    })
    // Every per-entry Undo button in the session is also gone.
    expect(screen.queryAllByLabelText(undoLabel)).toHaveLength(0)
  })

  it('keeps the per-entry Undo button clickable after a failed revert (user can retry)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') {
        throw Object.assign(new Error('disk full'), { kind: 'database' })
      }
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 17 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    await user.click(btn)

    // Error toast fires — but the button stays in the DOM and clickable.
    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Could not undo agent action')
    })
    expect(screen.getByLabelText(undoLabel)).toBeInTheDocument()
    // The in-flight state clears so the button is re-enabled for retry.
    await waitFor(() => {
      expect(screen.getByLabelText(undoLabel)).not.toBeDisabled()
    })
  })

  it('reduces the session-header count by one after a per-entry Undo in a 5-op session', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      for (let i = 1; i <= 5; i++) {
        fireActivityEvent(
          makeActivityEntry({
            toolName: 'create_block',
            timestamp: new Date(2024, 0, 1, 0, 0, i).toISOString(),
            sessionId: 'SESSION_FIVE',
            opRef: { device_id: 'D', seq: i },
          }),
        )
      }
    })

    // Header shows "5 agent actions".
    const header = await screen.findByTestId('mcp-activity-session-header')
    expect(header).toHaveTextContent('5 agent actions')

    // Click the per-entry Undo on one row (any of them).
    const undoBtns = screen.getAllByLabelText(undoLabel)
    expect(undoBtns).toHaveLength(5)
    await user.click(undoBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalledWith('Agent action undone')
    })

    // The filter drops one opRef from `undoableBySession`; the header
    // count drops to "4 agent actions" but the header stays present
    // (4 ≥ 2).
    await waitFor(() => {
      expect(screen.getByTestId('mcp-activity-session-header')).toHaveTextContent('4 agent actions')
    })
    expect(screen.getAllByLabelText(undoLabel)).toHaveLength(4)
  })

  it('hides the session header after a per-entry Undo in a 2-op session drops the count to 1', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'create_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
          sessionId: 'SESSION_TWO',
          opRef: { device_id: 'D', seq: 1 },
        }),
      )
      fireActivityEvent(
        makeActivityEntry({
          toolName: 'edit_block',
          timestamp: new Date(2024, 0, 1, 0, 0, 2).toISOString(),
          sessionId: 'SESSION_TWO',
          opRef: { device_id: 'D', seq: 2 },
        }),
      )
    })

    // Header renders with "2 agent actions".
    const header = await screen.findByTestId('mcp-activity-session-header')
    expect(header).toHaveTextContent('2 agent actions')

    const undoBtns = screen.getAllByLabelText(undoLabel)
    expect(undoBtns).toHaveLength(2)
    await user.click(undoBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalledWith('Agent action undone')
    })

    // 1 remaining op → header gate `sessionOps.length >= 2` fails and
    // the header vanishes. Per-entry Undo still visible on the remaining
    // row.
    await waitFor(() => {
      expect(screen.queryByTestId('mcp-activity-session-header')).not.toBeInTheDocument()
    })
    expect(screen.getAllByLabelText(undoLabel)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// UX-253 — per-entry Undo button carries a visible text label next to
// the icon on coarse-pointer (touch) devices.
//
// Desktop keeps the minimal icon-only chrome. Touch users see "Undo"
// text rendered inside a `<span>` with a Tailwind arbitrary-media
// class `[@media(pointer:coarse)]:inline` that flips the default
// `hidden` class on coarse pointers. jsdom does NOT evaluate
// `@media(pointer:coarse)` rules, so the tests assert DOM structure
// (span present, class pinned) rather than computed visibility.
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — touch discoverability (UX-253)', () => {
  const undoLabel = 'Undo this agent action'

  it('renders the buttonText span with the responsive class when the icon is visible', async () => {
    setupInvoke(makeStatus())
    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 1 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    // Text label is always in the DOM when the icon is shown (not
    // while in-flight). CSS `[@media(pointer:coarse)]:inline` flips
    // it visible on coarse pointers — jsdom can't evaluate that, so
    // we pin the class instead.
    const label = within(btn).getByText('Undo')
    expect(label).toBeInTheDocument()
    expect(label).toHaveClass('hidden')
    expect(label).toHaveClass('[@media(pointer:coarse)]:inline')
  })

  it('replaces the icon+text fragment with a spinner while the revert is in flight', async () => {
    const user = userEvent.setup()
    let resolveRevert: ((value: unknown) => void) | undefined
    const revertPromise = new Promise((r) => {
      resolveRevert = r
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'revert_ops') return revertPromise
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    await screen.findByText('Read-only access')

    act(() => {
      fireActivityEvent(makeActivityEntry({ opRef: { device_id: 'D', seq: 1 } }))
    })

    const btn = await screen.findByLabelText(undoLabel)
    // Label present before the click.
    expect(within(btn).getByText('Undo')).toBeInTheDocument()

    await user.click(btn)

    // While in-flight the whole icon+text fragment is replaced by the
    // spinner — the "Undo" span is no longer in the DOM.
    await waitFor(() => {
      expect(within(btn).queryByText('Undo')).not.toBeInTheDocument()
    })
    expect(btn.querySelector('[data-slot="spinner"]')).not.toBeNull()

    // Resolve the deferred invoke; UX-252 then removes the entire
    // button from the DOM on success.
    await act(async () => {
      resolveRevert?.(undefined)
      await revertPromise
    })

    await waitFor(() => {
      expect(screen.queryByLabelText(undoLabel)).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Kill switch — RO
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — kill switch', () => {
  it('disables the disconnect button when no connections are active', async () => {
    setupInvoke(makeStatus({ active_connections: 0 }))
    render(<AgentAccessSettingsTab />)

    const btn = await screen.findByRole('button', { name: 'Disconnect all' })
    expect(btn).toBeDisabled()
  })

  it('fires mcp_disconnect_all after confirming the dialog', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ active_connections: 3 }))

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: 'Disconnect all' })
    expect(btn).not.toBeDisabled()

    await user.click(btn)

    // Confirmation dialog appears; click the Action.
    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', { name: 'Disconnect all' })
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_disconnect_all')
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Disconnected all active sessions')
  })

  it('logs and toasts when mcp_disconnect_all rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus({ active_connections: 1 })
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      if (cmd === 'mcp_disconnect_all') throw new Error('backend exploded')
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: 'Disconnect all' })
    await user.click(btn)

    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', { name: 'Disconnect all' })
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'AgentAccessSettingsTab',
        'failed to disconnect all',
        undefined,
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to disconnect sessions')
  })
})

// ---------------------------------------------------------------------------
// Kill switch — RW
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — RW kill switch', () => {
  it('disables the RW disconnect button when no RW connections are active', async () => {
    setupInvoke(makeStatus(), makeRwStatus({ active_connections: 0 }))
    render(<AgentAccessSettingsTab />)

    const btn = await screen.findByRole('button', { name: 'Disconnect all read-write' })
    expect(btn).toBeDisabled()
  })

  it('fires mcp_rw_disconnect_all after confirming the dialog and reloads status', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus(), makeRwStatus({ active_connections: 2 }))

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: 'Disconnect all read-write' })
    expect(btn).not.toBeDisabled()

    await user.click(btn)

    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', {
      name: 'Disconnect all read-write',
    })
    // Capture call count BEFORE the confirm — we expect status to be
    // re-fetched after the disconnect succeeds.
    const preCount = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_mcp_rw_status').length
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('mcp_rw_disconnect_all')
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Disconnected all active read-write sessions')
    // `loadStatus` re-fetches after disconnect succeeds.
    await waitFor(() => {
      const postCount = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_mcp_rw_status').length
      expect(postCount).toBeGreaterThan(preCount)
    })
  })

  it('logs and toasts when mcp_rw_disconnect_all rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus()
      if (cmd === 'get_mcp_rw_status') return makeRwStatus({ active_connections: 1 })
      if (cmd === 'mcp_rw_disconnect_all') throw new Error('rw backend exploded')
      return undefined
    })

    render(<AgentAccessSettingsTab />)
    const btn = await screen.findByRole('button', { name: 'Disconnect all read-write' })
    await user.click(btn)

    const confirm = await screen.findByRole('alertdialog')
    const actionBtn = await within(confirm).findByRole('button', {
      name: 'Disconnect all read-write',
    })
    await user.click(actionBtn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'AgentAccessSettingsTab',
        'failed to disconnect all RW',
        undefined,
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to disconnect read-write sessions')
  })
})

// ---------------------------------------------------------------------------
// Status load error
// ---------------------------------------------------------------------------

describe('AgentAccessSettingsTab — status load error', () => {
  it('renders a degraded fallback UI when get_mcp_status rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') throw new Error('backend down')
      if (cmd === 'get_mcp_rw_status') return makeRwStatus()
      return undefined
    })

    render(<AgentAccessSettingsTab />)

    // Error banner surfaces the failure.
    expect(await screen.findByText('Failed to load MCP status')).toBeInTheDocument()
    // Component still renders the rest of the sections.
    expect(screen.getByText('Read-only access')).toBeInTheDocument()
    expect(screen.getByText('Read-write access')).toBeInTheDocument()
    // Logger captured the error.
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to load MCP status',
      undefined,
      expect.any(Error),
    )
    // RO toggle is forced to the off position + disabled while status is null.
    const toggle = screen.getByRole('switch', { name: 'Read-only access' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    // RW toggle still responds because its status loaded successfully.
    const rwToggle = screen.getByRole('switch', { name: 'Read-write access' })
    expect(rwToggle).not.toBeDisabled()
  })

  it('renders gracefully when only get_mcp_rw_status rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_mcp_status') return makeStatus({ enabled: true })
      if (cmd === 'get_mcp_rw_status') throw new Error('rw backend down')
      return undefined
    })

    render(<AgentAccessSettingsTab />)

    // RO side renders normally with no banner.
    expect(await screen.findByText('Read-only access')).toBeInTheDocument()
    expect(screen.queryByText('Failed to load MCP status')).not.toBeInTheDocument()
    // RW side still renders its shell (label + socket path code block
    // + kill switch) even though its status failed to load.
    expect(screen.getByText('Read-write access')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-rw-socket-path')).toBeInTheDocument()
    // Logger captured the RW failure.
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'AgentAccessSettingsTab',
      'failed to load MCP RW status',
      undefined,
      expect.any(Error),
    )
    // RW toggle is disabled while its status is null.
    const rwToggle = screen.getByRole('switch', { name: 'Read-write access' })
    expect(rwToggle).toBeDisabled()
    expect(rwToggle).toHaveAttribute('aria-checked', 'false')
    // Destructive warning badge is hidden while RW status is null.
    expect(screen.queryByTestId('mcp-rw-warning-badge')).not.toBeInTheDocument()
  })
})
