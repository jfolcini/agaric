/**
 * Tests for PairingDialog component.
 *
 * Validates:
 *  - Renders without crashing
 *  - Shows QR code when pairing info is loaded
 *  - Shows 4 word input fields
 *  - Pair button calls confirmPairing with entered words
 *  - Cancel button calls cancelPairing
 *  - Shows paired devices list
 *  - Unpair button calls deletePeerRef
 */

import { invoke } from '@tauri-apps/api/core'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PairingDialog } from '../PairingDialog'

// Mock react-qr-code — render a simple div with a data-testid
vi.mock('react-qr-code', () => ({
  default: ({ value, ...props }: { value: string; [key: string]: unknown }) => (
    <div data-testid="pairing-qr-code" data-value={value} {...props} />
  ),
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

const mockPairingInfo = {
  passphrase: 'alpha bravo charlie delta',
  qr_svg: '<svg>mock</svg>',
  port: 9000,
}

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    synced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    reset_count: 0,
    last_reset_at: null,
  },
  {
    peer_id: 'peer-def-0987654321',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 2,
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

describe('PairingDialog', () => {
  it('renders without crashing when closed', () => {
    render(<PairingDialog open={false} onOpenChange={vi.fn()} />)
    // Should render nothing visible
    expect(screen.queryByText('Pair Device')).not.toBeInTheDocument()
  })

  it('renders dialog when open', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Pair Device')).toBeInTheDocument()
  })

  it('shows QR code when pairing info is loaded', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    const qr = await screen.findByTestId('pairing-qr-code')
    expect(qr).toBeInTheDocument()
  })

  it('shows passphrase when pairing info is loaded', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('alpha bravo charlie delta')).toBeInTheDocument()
  })

  it('shows 4 word input fields', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const inputs = screen.getAllByRole('textbox')
    // 4 word inputs
    expect(inputs.length).toBe(4)

    // Check aria-labels
    expect(screen.getByLabelText('Passphrase word 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase word 4')).toBeInTheDocument()
  })

  it('Pair button calls confirmPairing with entered words', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      confirm_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0], 'echo')
    await user.type(inputs[1], 'foxtrot')
    await user.type(inputs[2], 'golf')
    await user.type(inputs[3], 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('confirm_pairing', {
        passphrase: 'echo foxtrot golf hotel',
        remoteDeviceId: '',
      })
    })
  })

  it('Pair button is disabled when words are empty', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    expect(pairBtn).toBeDisabled()
  })

  it('Cancel button calls cancelPairing and closes dialog', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={onOpenChange} />)

    // Wait for loading to finish
    await screen.findByText('alpha bravo charlie delta')

    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    await user.click(cancelBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows paired devices list', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for loading to finish
    await screen.findByText('Paired Devices')

    // Check peer IDs are shown
    expect(await screen.findByText('peer-abc-1234567890')).toBeInTheDocument()
    expect(screen.getByText('peer-def-0987654321')).toBeInTheDocument()

    // "Never synced" for the second peer (inside "Last: Never synced")
    expect(screen.getByText(/Never synced/)).toBeInTheDocument()
  })

  it('shows no paired devices message when empty', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    expect(await screen.findByText('No paired devices yet.')).toBeInTheDocument()
  })

  it('Unpair button calls deletePeerRef after confirmation', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: mockPeers,
      delete_peer_ref: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for peers to show
    await screen.findByText('peer-abc-1234567890')

    // Click first Unpair button
    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0])

    // Confirmation dialog appears
    expect(screen.getByText('Unpair device?')).toBeInTheDocument()

    // Confirm
    const yesBtn = screen.getByRole('button', { name: /Yes, unpair/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_peer_ref', {
        peerId: 'peer-abc-1234567890',
      })
    })

    // Peer should be removed from list
    await waitFor(() => {
      expect(screen.queryByText('peer-abc-1234567890')).not.toBeInTheDocument()
    })
  })

  it('shows error when startPairing fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') throw new Error('network error')
      if (cmd === 'list_peer_refs') return []
      return undefined
    })

    const { container } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Error text appears in both the visible .pairing-error and the sr-only aria-live div
    await waitFor(() => {
      const errorEl = container.querySelector('.pairing-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toBe('Failed to start pairing. Please try again.')
    })
  })

  it('shows error when confirmPairing fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_pairing') return mockPairingInfo
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'confirm_pairing') throw new Error('pairing failed')
      return undefined
    })

    const { container } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('alpha bravo charlie delta')

    const inputs = screen.getAllByRole('textbox')
    await user.type(inputs[0], 'echo')
    await user.type(inputs[1], 'foxtrot')
    await user.type(inputs[2], 'golf')
    await user.type(inputs[3], 'hotel')

    const pairBtn = screen.getByRole('button', { name: /^Pair$/i })
    await user.click(pairBtn)

    await waitFor(() => {
      const errorEl = container.querySelector('.pairing-error')
      expect(errorEl).toBeTruthy()
      expect(errorEl?.textContent).toBe('Pairing failed. Check the passphrase and try again.')
    })
  })

  it('shows loading state while initializing', async () => {
    // Make start_pairing hang
    mockedInvoke.mockImplementation(
      () => new Promise(() => {}), // never resolves
    )

    const { container } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      const loadingEl = container.querySelector('.pairing-loading')
      expect(loadingEl).toBeTruthy()
      expect(loadingEl?.textContent).toContain('Starting pairing...')
    })
  })

  it('has no a11y violations when open with pairing info', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for content to load
    await screen.findByText('alpha bravo charlie delta')

    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })

  it('calls cancelPairing when dialog closes via onOpenChange(false)', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    const { rerender } = render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Simulate parent closing the dialog
    rerender(<PairingDialog open={false} onOpenChange={vi.fn()} />)

    // cancelPairing should be called by the cleanup effect
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
    })
  })

  it('calls cancelPairing on unmount', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    // Wait for pairing to start
    await screen.findByText('alpha bravo charlie delta')

    // Unmount the component
    cleanup()

    // cancelPairing should be called by the cleanup effect
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_pairing')
  })

  it('dialog has aria-labelledby pointing to the title', async () => {
    mockInvokeByCommand({
      start_pairing: mockPairingInfo,
      list_peer_refs: [],
      cancel_pairing: undefined,
    })

    render(<PairingDialog open={true} onOpenChange={vi.fn()} />)

    await screen.findByText('Pair Device')

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-labelledby')).toBe('pairing-dialog-title')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')

    const title = document.getElementById('pairing-dialog-title')
    expect(title).toBeTruthy()
    expect(title?.textContent).toBe('Pair Device')
  })
})
