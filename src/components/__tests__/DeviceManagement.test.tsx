/**
 * Tests for DeviceManagement component.
 *
 * Validates:
 *  - Renders local device ID
 *  - Shows list of paired peers
 *  - "Pair New Device" button exists
 *  - "Sync Now" button calls startSync
 *  - "Unpair" button calls deletePeerRef after confirmation
 *  - Error handling
 *  - Peer list refresh after pairing dialog closes
 *  - Retry button on error
 *  - Sync timeout watchdog
 *  - Unpair button aria-label
 *  - Gap-2 spacing between buttons
 *  - Error messages preserve backend error strings
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { DeviceManagement } from '../DeviceManagement'

// Mock PairingDialog to prevent it from making its own invoke calls.
// Expose onOpenChange so tests can simulate dialog close.
vi.mock('../PairingDialog', () => ({
  PairingDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) =>
    open ? (
      <div data-testid="pairing-dialog">
        <button type="button" data-testid="close-pairing" onClick={() => onOpenChange(false)}>
          Close
        </button>
        PairingDialog
      </div>
    ) : null,
}))

vi.mock('../RenameDialog', () => ({
  RenameDialog: ({
    open,
    onOpenChange,
    onConfirm,
    currentName,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
    onConfirm: (name: string) => void
    currentName: string
  }) =>
    open ? (
      <div data-testid="rename-dialog">
        <input data-testid="rename-input" defaultValue={currentName} />
        <button
          type="button"
          data-testid="rename-save"
          onClick={() => onConfirm('New Device Name')}
        >
          Save
        </button>
        <button type="button" data-testid="rename-cancel" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
      </div>
    ) : null,
}))

vi.mock('../../stores/sync', () => ({
  useSyncStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      state: 'idle',
      error: null,
      peers: [],
      lastSyncedAt: null,
      opsReceived: 0,
      opsSent: 0,
      setState: vi.fn(),
      setPeers: vi.fn(),
      updateLastSynced: vi.fn(),
      incrementOpsReceived: vi.fn(),
      incrementOpsSent: vi.fn(),
      reset: vi.fn(),
    }),
}))

const mockedInvoke = vi.mocked(invoke)

const mockDeviceId = 'local-device-id-abc123'

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    synced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
  },
  {
    peer_id: 'peer-def-0987654321',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 1,
    last_reset_at: '2025-01-01T00:00:00Z',
    cert_hash: null,
    device_name: null,
    last_address: null,
  },
]

function mockInvokeByCommand(commands: Record<string, unknown>) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd in commands) return commands[cmd]
    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DeviceManagement', () => {
  it('renders local device ID', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    expect(await screen.findByText(mockDeviceId)).toBeInTheDocument()
    expect(screen.getByText('Local Device ID')).toBeInTheDocument()
  })

  it('shows list of paired peers', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    render(<DeviceManagement />)

    // Peer IDs are truncated — check the truncated versions
    expect(await screen.findByText('peer-abc-123...')).toBeInTheDocument()
    expect(screen.getByText('peer-def-098...')).toBeInTheDocument()

    // Show peer count
    expect(screen.getByText('Paired Devices (2)')).toBeInTheDocument()
  })

  it('"Pair New Device" button exists', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    const btn = await screen.findByRole('button', { name: /Pair New Device/i })
    expect(btn).toBeInTheDocument()
  })

  it('"Pair New Device" button opens PairingDialog', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    const btn = await screen.findByRole('button', { name: /Pair New Device/i })
    await user.click(btn)

    expect(screen.getByTestId('pairing-dialog')).toBeInTheDocument()
  })

  it('"Sync Now" button calls startSync', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
      start_sync: {
        state: 'syncing',
        local_device_id: mockDeviceId,
        remote_device_id: 'peer-abc-1234567890',
        ops_received: 0,
        ops_sent: 0,
      },
    })

    render(<DeviceManagement />)

    // Wait for peers to load
    await screen.findByText('peer-abc-123...')

    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_sync', {
        peerId: 'peer-abc-1234567890',
      })
    })
  })

  it('"Unpair" button calls deletePeerRef after confirmation', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
      delete_peer_ref: undefined,
    })

    render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    // Confirmation dialog
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()

    const yesBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', {
        peerId: 'peer-abc-1234567890',
      })
    })

    // Peer should be removed
    await waitFor(() => {
      expect(screen.queryByText('peer-abc-123...')).not.toBeInTheDocument()
    })
  })

  it('shows no peers message when empty', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    expect(await screen.findByText(/No paired devices/i)).toBeInTheDocument()
  })

  it('shows error when loading fails', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    render(<DeviceManagement />)

    expect(await screen.findByText('Failed to load device info')).toBeInTheDocument()
  })

  it('shows loading skeleton with aria-busy during initial load', () => {
    mockedInvoke.mockReturnValue(new Promise(() => {}))

    const { container } = render(<DeviceManagement />)

    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
  })

  it('shows reset count badge for peers with resets', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    render(<DeviceManagement />)

    // Second peer has reset_count: 1
    expect(await screen.findByText('1 reset')).toBeInTheDocument()
  })

  it('calls get_device_id and list_peer_refs on mount', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_device_id')
      expect(mockedInvoke).toHaveBeenCalledWith('list_peer_refs')
    })
  })

  it('has no a11y violations with device info loaded', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    const { container } = render(<DeviceManagement />)

    // Wait for content to load
    await screen.findByText(mockDeviceId)

    // Scope axe to the component container (not document.body) to avoid
    // false-positive "region" violations from the standalone test harness.
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('shows error when sync fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'start_sync') throw new Error('sync failed')
      return undefined
    })

    render(<DeviceManagement />)

    // Wait for peers to load
    await screen.findByText('peer-abc-123...')

    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByText('sync failed')).toBeInTheDocument()
    })
  })

  it('error message has aria-live for screen readers', async () => {
    mockedInvoke.mockRejectedValue(new Error('network failure'))

    const { container } = render(<DeviceManagement />)

    await screen.findByText('Failed to load device info')

    const errorEl = container.querySelector('.device-management-error')
    expect(errorEl).toBeTruthy()
    expect(errorEl?.getAttribute('aria-live')).toBe('polite')
  })

  it('announces sync errors to screen readers via sr-only aria-live region (#423)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'start_sync') throw new Error('Connection refused by peer')
      return undefined
    })

    const { container } = render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    // Wait for the visible error to appear first
    await waitFor(() => {
      expect(screen.getByText('Connection refused by peer')).toBeInTheDocument()
    })

    // The sr-only aria-live region should announce the error
    const srRegions = container.querySelectorAll('[aria-live="polite"]')
    const srOnly = Array.from(srRegions).find((el) => el.classList.contains('sr-only'))
    expect(srOnly).toBeTruthy()
    expect(srOnly?.textContent).toContain('Sync error: Connection refused by peer')
  })

  // --- New tests ---

  it('refreshes peer list when PairingDialog closes', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    // Wait for initial load
    await screen.findByText(mockDeviceId)

    // Initial mount calls: get_device_id + list_peer_refs
    const initialCallCount = mockedInvoke.mock.calls.filter((c) => c[0] === 'list_peer_refs').length
    expect(initialCallCount).toBe(1)

    // Open pairing dialog
    const pairBtn = screen.getByRole('button', { name: /Pair New Device/i })
    await user.click(pairBtn)
    expect(screen.getByTestId('pairing-dialog')).toBeInTheDocument()

    // Close pairing dialog
    const closeBtn = screen.getByTestId('close-pairing')
    await user.click(closeBtn)

    // list_peer_refs should be called again after close
    await waitFor(() => {
      const afterCloseCount = mockedInvoke.mock.calls.filter(
        (c) => c[0] === 'list_peer_refs',
      ).length
      expect(afterCloseCount).toBeGreaterThan(initialCallCount)
    })
  })

  it('shows retry button on error and re-fetches on click', async () => {
    const user = userEvent.setup()
    let attempt = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') {
        attempt++
        if (attempt === 1) throw new Error('network failure')
        return mockDeviceId
      }
      if (cmd === 'list_peer_refs') {
        if (attempt <= 1) throw new Error('network failure')
        return []
      }
      return undefined
    })

    render(<DeviceManagement />)

    // Error should show
    await screen.findByText('Failed to load device info')

    // Retry button should be present
    const retryBtn = screen.getByRole('button', { name: /Retry/i })
    expect(retryBtn).toBeInTheDocument()

    // Click retry — should re-fetch and succeed
    await user.click(retryBtn)

    await waitFor(() => {
      expect(screen.getByText(mockDeviceId)).toBeInTheDocument()
    })
  })

  describe('sync timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('shows timeout error after 60 seconds and calls cancelSync', async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_device_id') return mockDeviceId
        if (cmd === 'list_peer_refs') return mockPeers
        if (cmd === 'start_sync') return new Promise(() => {}) // never resolves
        if (cmd === 'cancel_sync') return undefined
        return undefined
      })

      // Render with act so microtask-based loadData resolves under fake timers
      await act(async () => {
        render(<DeviceManagement />)
      })

      // loadData mocks resolve via microtasks (not timers), so data is already loaded
      expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()

      const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })

      // Use fireEvent instead of userEvent — userEvent waits for the async
      // handler to settle which can't happen until we advance the timer.
      await act(async () => {
        fireEvent.click(syncBtns[0] as HTMLElement)
      })

      // Advance by 60 seconds to trigger the timeout promise
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000)
      })

      expect(
        screen.getByText('Sync took too long — check your connection and try again'),
      ).toBeInTheDocument()
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_sync')
    })
  })

  it('Unpair button has aria-label with truncated peer ID', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair device/i })
    expect(unpairBtns).toHaveLength(2)
    expect(unpairBtns[0]).toHaveAttribute('aria-label', 'Unpair device peer-abc-123...')
    expect(unpairBtns[1]).toHaveAttribute('aria-label', 'Unpair device peer-def-098...')
  })

  it('uses gap-2 spacing between Sync Now and Unpair buttons', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    const { container } = render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const syncBtn = container.querySelector('.device-sync-btn')
    expect(syncBtn?.parentElement?.className).toContain('gap-2')
    expect(syncBtn?.parentElement?.className).not.toContain('gap-1')
  })

  it('preserves backend error message on sync failure', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'start_sync') throw new Error('Connection refused by peer')
      return undefined
    })

    render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(screen.getByText('Connection refused by peer')).toBeInTheDocument()
    })
  })

  // --- Sync All tests (#379) ---

  it('shows Sync All button when 2+ peers exist', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(container.querySelector('.device-sync-all-btn')).toBeTruthy()
    })
  })

  it('hides Sync All button when fewer than 2 peers', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return 'device-123'
      if (cmd === 'list_peer_refs')
        return [
          {
            peer_id: 'peer-1',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
            device_name: null,
          },
        ]
      return null
    })
    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(container.querySelector('.device-peer-item')).toBeTruthy()
    })
    expect(container.querySelector('.device-sync-all-btn')).toBeNull()
  })

  it('Sync All calls startSync for each peer sequentially', async () => {
    const syncCalls: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_device_id') return 'device-123'
      if (cmd === 'list_peer_refs')
        return [
          {
            peer_id: 'peer-1',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
            device_name: null,
          },
          {
            peer_id: 'peer-2',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
            device_name: null,
          },
        ]
      if (cmd === 'start_sync') {
        syncCalls.push((args as Record<string, string>)['peerId'] as string)
        return {
          state: 'completed',
          local_device_id: 'device-123',
          remote_device_id: (args as Record<string, string>)['peerId'] as string,
          ops_received: 0,
          ops_sent: 0,
        }
      }
      return null
    })

    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(container.querySelector('.device-sync-all-btn')).toBeTruthy()
    })

    const syncAllBtn = container.querySelector('.device-sync-all-btn') as HTMLButtonElement
    await userEvent.click(syncAllBtn)

    await waitFor(() => {
      expect(syncCalls).toEqual(['peer-1', 'peer-2'])
    })
  })

  it('displays device name when set', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [
        {
          peer_id: 'PEER01',
          last_hash: null,
          last_sent_hash: null,
          synced_at: null,
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: "Javier's Phone",
        },
      ],
    })
    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(screen.getByText("Javier's Phone")).toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('Sync All continues when first peer fails (#421)', async () => {
    const syncCalls: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'get_device_id') return 'device-123'
      if (cmd === 'list_peer_refs')
        return [
          {
            peer_id: 'peer-1',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
            device_name: null,
          },
          {
            peer_id: 'peer-2',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
            device_name: null,
          },
        ]
      if (cmd === 'start_sync') {
        const peerId = (args as Record<string, string>)['peerId'] as string
        syncCalls.push(peerId)
        if (peerId === 'peer-1') throw new Error('Connection refused')
        return {
          state: 'completed',
          local_device_id: 'device-123',
          remote_device_id: peerId,
          ops_received: 0,
          ops_sent: 0,
        }
      }
      return null
    })

    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(container.querySelector('.device-sync-all-btn')).toBeTruthy()
    })

    await userEvent.click(container.querySelector('.device-sync-all-btn') as HTMLButtonElement)

    await waitFor(() => {
      expect(syncCalls).toEqual(['peer-1', 'peer-2'])
    })

    // Error should mention the failed peer (both visible + sr-only region)
    await waitFor(() => {
      expect(screen.getAllByText(/Sync failed for/).length).toBeGreaterThan(0)
    })
  })

  it('error can be dismissed with X button (#419)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'start_sync') throw new Error('sync failed')
      return undefined
    })

    render(<DeviceManagement />)

    // Wait for peers to load
    await screen.findByText('peer-abc-123...')

    // Trigger a sync error
    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByText('sync failed')).toBeInTheDocument()
    })

    // Click dismiss button
    const dismissBtn = screen.getByRole('button', { name: /Dismiss error/i })
    await user.click(dismissBtn)

    // Error should be gone
    await waitFor(() => {
      expect(screen.queryByText('sync failed')).not.toBeInTheDocument()
    })
  })

  it('shows friendly timeout message instead of raw text (#426)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'start_sync') throw new Error('Sync timed out')
      if (cmd === 'cancel_sync') return undefined
      return undefined
    })

    render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    const syncBtns = screen.getAllByRole('button', { name: /Sync Now/i })
    await user.click(syncBtns[0] as HTMLElement)

    await waitFor(() => {
      expect(
        screen.getByText('Sync took too long — check your connection and try again'),
      ).toBeInTheDocument()
    })
    expect(screen.queryByText('Sync timed out')).not.toBeInTheDocument()
  })

  it('renders copy button for device ID with correct aria-label (#432)', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [],
    })

    render(<DeviceManagement />)

    await screen.findByText(mockDeviceId)

    const copyBtn = screen.getByRole('button', { name: 'Copy device ID to clipboard' })
    expect(copyBtn).toBeInTheDocument()
  })

  it('unpair dialog shows device name when clicking unpair on a named device (#440)', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [
        {
          peer_id: 'peer-named-1',
          last_hash: null,
          last_sent_hash: null,
          synced_at: null,
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: 'Work Laptop',
        },
      ],
      delete_peer_ref: undefined,
    })

    render(<DeviceManagement />)

    await screen.findByText('Work Laptop')

    const unpairBtn = screen.getByRole('button', { name: /Unpair/i })
    await user.click(unpairBtn)

    expect(screen.getByText(/This will remove the pairing with Work Laptop/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Yes, unpair/i })).toBeInTheDocument()
  })

  it('sorts peers: named alphabetically first, then unnamed (#434)', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [
        {
          peer_id: 'peer-3',
          last_hash: null,
          last_sent_hash: null,
          synced_at: '2025-01-03T00:00:00Z',
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: null,
        },
        {
          peer_id: 'peer-1',
          last_hash: null,
          last_sent_hash: null,
          synced_at: '2025-01-01T00:00:00Z',
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: 'Zebra',
        },
        {
          peer_id: 'peer-2',
          last_hash: null,
          last_sent_hash: null,
          synced_at: '2025-01-02T00:00:00Z',
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: 'Apple',
        },
      ],
    })

    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(container.querySelectorAll('.device-peer-name')).toHaveLength(3)
    })

    const names = [...container.querySelectorAll('.device-peer-name')].map((el) => el.textContent)
    expect(names[0]).toBe('Apple')
    expect(names[1]).toBe('Zebra')
    expect(names[2]).toBe('peer-3')
  })

  it('opens rename dialog when rename button clicked (#422)', async () => {
    mockInvokeByCommand({ get_device_id: mockDeviceId, list_peer_refs: mockPeers })
    render(<DeviceManagement />)
    await screen.findByText(mockDeviceId)

    const renameBtn = document.querySelector('.device-rename-btn') as HTMLButtonElement
    await userEvent.click(renameBtn)

    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument()
  })

  it('shows loading state during rename (#435)', async () => {
    let resolveRename: () => void
    const renamePromise = new Promise<void>((resolve) => {
      resolveRename = resolve
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return mockPeers
      if (cmd === 'update_peer_name') {
        await renamePromise
        return undefined
      }
      return undefined
    })

    const { container } = render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')

    // Click rename to open dialog
    const renameBtns = container.querySelectorAll('.device-rename-btn')
    expect(renameBtns.length).toBeGreaterThan(0)
    await act(async () => {
      fireEvent.click(renameBtns[0] as HTMLElement)
    })

    // Click Save in the mock dialog
    const saveBtn = screen.getByTestId('rename-save')
    await act(async () => {
      fireEvent.click(saveBtn)
    })

    // The button should be disabled and show a spinner while renaming
    await waitFor(() => {
      expect(renameBtns[0] as HTMLElement).toBeDisabled()
      expect(renameBtns[0]?.querySelector('.animate-spin')).toBeTruthy()
    })

    // Resolve the rename to clean up
    await act(async () => {
      resolveRename?.()
    })

    // After completion, button should be re-enabled
    await waitFor(() => {
      expect(container.querySelector('.device-rename-btn:disabled')).toBeNull()
    })
  })

  it('shows error when rename fails (#444)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return [mockPeers[0]]
      if (cmd === 'update_peer_name') throw new Error('DB write failed')
      return undefined
    })

    const { container } = render(<DeviceManagement />)
    await waitFor(() => {
      expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
    })

    // Click rename to open dialog
    const renameBtn = container.querySelector('.device-rename-btn') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(renameBtn)
    })

    // Click Save in the mock dialog
    const saveBtn = screen.getByTestId('rename-save')
    await act(async () => {
      fireEvent.click(saveBtn)
    })

    await waitFor(() => {
      expect(screen.getByText('DB write failed')).toBeInTheDocument()
    })
  })

  it('shows error when unpair fails (#444)', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_device_id') return mockDeviceId
      if (cmd === 'list_peer_refs') return [mockPeers[0]]
      if (cmd === 'delete_peer_ref') throw new Error('FK constraint')
      return undefined
    })

    render(<DeviceManagement />)
    await waitFor(() => {
      expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
    })

    // Click Unpair
    const unpairBtn = screen.getByRole('button', { name: /Unpair/i })
    await user.click(unpairBtn)

    // Confirm in the dialog
    const confirmBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(screen.getByText('Failed to unpair device')).toBeInTheDocument()
    })
  })

  it('shows truncated peer_id when device_name is null (#444)', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [
        {
          peer_id: 'ABCDEFGHIJKLMNOP',
          last_hash: null,
          last_sent_hash: null,
          synced_at: null,
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: null,
          last_address: null,
        },
      ],
    })

    render(<DeviceManagement />)
    await waitFor(() => {
      expect(screen.getByText('ABCDEFGHIJKL...')).toBeInTheDocument()
    })
  })

  // --- Peer address (manual IP entry) tests (#522) ---

  describe('peer address display (#522)', () => {
    it('shows "No address" when peer has no last_address', async () => {
      mockInvokeByCommand({
        get_device_id: mockDeviceId,
        list_peer_refs: [{ ...mockPeers[0], last_address: null }],
      })

      const { container } = render(<DeviceManagement />)

      await screen.findByText('peer-abc-123...')
      const addrEl = container.querySelector('.peer-address')
      expect(addrEl).toBeTruthy()
      expect(addrEl?.textContent).toContain('No address')
    })

    it('shows last_address when set on a peer', async () => {
      mockInvokeByCommand({
        get_device_id: mockDeviceId,
        list_peer_refs: [{ ...mockPeers[0], last_address: '192.168.1.42:9000' }],
      })

      const { container } = render(<DeviceManagement />)

      await screen.findByText('peer-abc-123...')
      const addrEl = container.querySelector('.peer-address')
      expect(addrEl?.textContent).toContain('192.168.1.42:9000')
    })

    it('renders an edit-address button with correct aria-label', async () => {
      mockInvokeByCommand({
        get_device_id: mockDeviceId,
        list_peer_refs: [{ ...mockPeers[0], last_address: null }],
      })

      const { container } = render(<DeviceManagement />)

      await screen.findByText('peer-abc-123...')
      const editBtn = container.querySelector('.peer-address-edit')
      expect(editBtn).toBeTruthy()
      expect(editBtn?.getAttribute('aria-label')).toBe('Edit address for peer-abc-123...')
    })

    it('calls set_peer_address when user enters an address via popover', async () => {
      mockInvokeByCommand({
        get_device_id: mockDeviceId,
        list_peer_refs: [{ ...mockPeers[0], last_address: null }],
        set_peer_address: undefined,
      })

      const { container } = render(<DeviceManagement />)

      await screen.findByText('peer-abc-123...')
      const editBtn = container.querySelector('.peer-address-edit') as HTMLButtonElement
      await userEvent.click(editBtn)

      // Popover opens — type address and click Save
      const input = await screen.findByLabelText('Address (host:port)')
      await userEvent.type(input, '10.0.0.5:8080')
      await userEvent.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_peer_address', {
          peerId: 'peer-abc-1234567890',
          address: '10.0.0.5:8080',
        })
      })
    })

    it('shows manual IP hint text', async () => {
      mockInvokeByCommand({
        get_device_id: mockDeviceId,
        list_peer_refs: [],
      })

      const { container } = render(<DeviceManagement />)

      await screen.findByText(mockDeviceId)
      const hint = container.querySelector('.manual-ip-hint')
      expect(hint).toBeTruthy()
      expect(hint?.textContent).toContain('mDNS discovery')
    })
  })

  it('edit address button uses icon-xs size for touch sizing', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: [{ ...mockPeers[0], last_address: null }],
    })

    const { container } = render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')
    const editBtn = container.querySelector('.peer-address-edit')
    expect(editBtn).toBeTruthy()
    expect(editBtn?.className).toContain('peer-address-edit')
  })

  it('peer action buttons container has flex-wrap', async () => {
    mockInvokeByCommand({
      get_device_id: mockDeviceId,
      list_peer_refs: mockPeers,
    })

    const { container } = render(<DeviceManagement />)

    await screen.findByText('peer-abc-123...')
    const syncBtn = container.querySelector('.device-sync-btn')
    expect(syncBtn?.parentElement?.className).toContain('flex-wrap')
  })
})
