/**
 * Tests for PairingPeersList component.
 *
 * Validates:
 *  - Shows "Paired Devices" heading
 *  - Shows "No paired devices yet." when empty
 *  - Renders peer IDs in the list
 *  - Shows last synced time for peers
 *  - Shows "Never synced" for peers with null synced_at
 *  - Shows reset count badge when > 0
 *  - Hides reset badge when count is 0
 *  - Unpair button calls onUnpair with the peer ID
 *  - Renders separator
 *  - Accessibility audit
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PairingPeersList } from '../PairingPeersList'

beforeEach(() => {
  vi.clearAllMocks()
})

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    synced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
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
    reset_count: 2,
    last_reset_at: '2025-01-01T00:00:00Z',
    cert_hash: null,
    device_name: null,
    last_address: null,
  },
]

describe('PairingPeersList', () => {
  it('shows "Paired Devices" heading', () => {
    render(<PairingPeersList peers={[]} onUnpair={vi.fn()} />)

    expect(screen.getByText('Paired Devices')).toBeInTheDocument()
  })

  it('shows "No paired devices yet." when empty', () => {
    render(<PairingPeersList peers={[]} onUnpair={vi.fn()} />)

    expect(screen.getByText('No paired devices yet.')).toBeInTheDocument()
  })

  it('renders peer IDs in the list', () => {
    render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    expect(screen.getByText('peer-abc-1234567890')).toBeInTheDocument()
    expect(screen.getByText('peer-def-0987654321')).toBeInTheDocument()
  })

  it('shows "Never synced" for peers with null synced_at', () => {
    render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    expect(screen.getByText(/Never synced/)).toBeInTheDocument()
  })

  it('shows last synced time for peers with synced_at', () => {
    render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    // The first peer was synced 5 minutes ago
    expect(screen.getByText(/Last: 5m ago/)).toBeInTheDocument()
  })

  it('shows reset count badge when > 0', () => {
    render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    expect(screen.getByText('2 resets')).toBeInTheDocument()
  })

  it('hides reset badge when count is 0', () => {
    // biome-ignore lint/style/noNonNullAssertion: test data known to exist
    const singlePeer = [mockPeers[0]!]
    render(<PairingPeersList peers={singlePeer} onUnpair={vi.fn()} />)

    expect(screen.queryByText(/reset/)).not.toBeInTheDocument()
  })

  it('shows singular "reset" for count of 1', () => {
    const peerWithOneReset = [
      {
        // biome-ignore lint/style/noNonNullAssertion: test data known to exist
        ...mockPeers[0]!,
        reset_count: 1,
      },
    ]
    render(<PairingPeersList peers={peerWithOneReset} onUnpair={vi.fn()} />)

    expect(screen.getByText('1 reset')).toBeInTheDocument()
  })

  it('renders Unpair button for each peer', () => {
    render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    expect(unpairBtns.length).toBe(2)
  })

  it('calls onUnpair with correct peer ID when clicking Unpair', async () => {
    const user = userEvent.setup()
    const onUnpair = vi.fn()
    render(<PairingPeersList peers={mockPeers} onUnpair={onUnpair} />)

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    expect(onUnpair).toHaveBeenCalledWith('peer-abc-1234567890')
  })

  it('calls onUnpair with second peer ID', async () => {
    const user = userEvent.setup()
    const onUnpair = vi.fn()
    render(<PairingPeersList peers={mockPeers} onUnpair={onUnpair} />)

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[1] as HTMLElement)

    expect(onUnpair).toHaveBeenCalledWith('peer-def-0987654321')
  })

  it('renders a separator', () => {
    const { container } = render(<PairingPeersList peers={[]} onUnpair={vi.fn()} />)

    const separator = container.querySelector('[data-slot="separator"]')
    expect(separator).toBeInTheDocument()
  })

  it('has no a11y violations with empty peers', async () => {
    const { container } = render(<PairingPeersList peers={[]} onUnpair={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with peers', async () => {
    const { container } = render(<PairingPeersList peers={mockPeers} onUnpair={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
