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
// Clipboard stub — jsdom does not provide `navigator.clipboard` out of
// the box. `@testing-library/user-event`'s `setup()` always installs its
// own clipboard stub via `attachClipboardStubToView`, which overrides
// any `navigator.clipboard` we defined earlier. Therefore every test
// that cares about the clipboard re-defines it AFTER `userEvent.setup()`
// via `installClipboardMock()`. Matches the pattern used by
// `BugReportDialog.test.tsx`.
// ---------------------------------------------------------------------------

let clipboardWriteText: ReturnType<typeof vi.fn>

function installClipboardMock(): void {
  clipboardWriteText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  })
}

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
    installClipboardMock()
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
    installClipboardMock()
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
    installClipboardMock()
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
    installClipboardMock()
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
    installClipboardMock()
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
      })
    })

    const row = await screen.findByTestId('mcp-activity-row')
    // Destructive text class applied to the summary span.
    expect(row.querySelector('.text-destructive')).not.toBeNull()
    expect(container).toBeDefined()
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
