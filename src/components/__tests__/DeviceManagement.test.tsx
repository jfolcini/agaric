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
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { DeviceManagement } from '../DeviceManagement'

// Mock PairingDialog to prevent it from making its own invoke calls
vi.mock('../PairingDialog', () => ({
  PairingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="pairing-dialog">PairingDialog</div> : null,
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
      expect(screen.getByText('Sync failed')).toBeInTheDocument()
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
})
