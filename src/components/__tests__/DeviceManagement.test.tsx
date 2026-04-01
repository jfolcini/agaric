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
  },
  {
    peer_id: 'peer-def-0987654321',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 1,
    last_reset_at: '2025-01-01T00:00:00Z',
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
    await user.click(syncBtns[0])

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
    await user.click(unpairBtns[0])

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
    await user.click(syncBtns[0])

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
        fireEvent.click(syncBtns[0])
      })

      // Advance by 60 seconds to trigger the timeout promise
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000)
      })

      expect(screen.getByText('Sync timed out')).toBeInTheDocument()
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
    await user.click(syncBtns[0])

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
          },
          {
            peer_id: 'peer-2',
            last_hash: null,
            last_sent_hash: null,
            synced_at: null,
            reset_count: 0,
            last_reset_at: null,
          },
        ]
      if (cmd === 'start_sync') {
        syncCalls.push((args as Record<string, string>).peerId)
        return {
          state: 'completed',
          local_device_id: 'device-123',
          remote_device_id: (args as Record<string, string>).peerId,
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
})
