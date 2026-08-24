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

import { PairingPeersList } from '@/components/peers/PairingPeersList'
import type { PeerRef } from '@/lib/bindings'

beforeEach(() => {
  vi.clearAllMocks()
})

const mockPeers = [
  {
    peer_id: 'peer-abc-1234567890',
    last_hash: 'hash1',
    last_sent_hash: null,
    streamed_at: null,
    synced_at: Date.now() - 5 * 60 * 1000,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
    endpoint_id: null,
  },
  {
    peer_id: 'peer-def-0987654321',
    last_hash: null,
    last_sent_hash: null,
    streamed_at: null,
    synced_at: null,
    reset_count: 2,
    last_reset_at: 1735689600000, // 2025-01-01T00:00:00Z
    cert_hash: null,
    device_name: null,
    last_address: null,
    endpoint_id: null,
  },
]

const [firstPeer] = mockPeers
if (firstPeer === undefined) throw new Error('mockPeers fixture must have at least one peer')

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

    // Rendered truncated (a real peer_id is a 36-char UUID; the full string
    // pushed Unpair off a 360px screen). The full id stays on `title`.
    expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
    expect(screen.getByText('peer-def-098...')).toBeInTheDocument()
    expect(screen.getByTitle('peer-abc-1234567890')).toBeInTheDocument()
    expect(screen.getByTitle('peer-def-0987654321')).toBeInTheDocument()
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
    const singlePeer = [firstPeer]
    render(<PairingPeersList peers={singlePeer} onUnpair={vi.fn()} />)

    expect(screen.queryByText(/reset/)).not.toBeInTheDocument()
  })

  // #2058: reset-count badge uses the i18next plural key (device.resetCount,
  // _one/_other), not hand-rolled `!== 1 ? 's' : ''` pluralization.
  it('shows singular "reset" for count of 1 via the device.resetCount _one form', () => {
    const peerWithOneReset = [
      {
        ...firstPeer,
        reset_count: 1,
      },
    ]
    render(<PairingPeersList peers={peerWithOneReset} onUnpair={vi.fn()} />)

    expect(screen.getByText('1 reset')).toBeInTheDocument()
    expect(screen.queryByText('1 resets')).not.toBeInTheDocument()
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

/**
 * #4084 — the pairing dialog's peer list uses the same
 * `MAX(synced_at, streamed_at)` reading as the device list, so the two never
 * disagree about whether a responder-only peer has ever synced.
 */
describe('PairingPeersList — last-sync activity (#4084)', () => {
  const responderOnly = [
    {
      peer_id: 'peer-responder-only',
      last_hash: null,
      last_sent_hash: null,
      streamed_at: Date.now() - 5 * 60 * 1000,
      synced_at: null,
      reset_count: 0,
      last_reset_at: null,
      cert_hash: null,
      device_name: null,
      last_address: null,
      endpoint_id: null,
    },
  ]

  it('does not say "never synced" for a peer that has only pulled from us', () => {
    render(<PairingPeersList peers={responderOnly} onUnpair={vi.fn()} />)

    expect(screen.queryByText(/Never synced/)).not.toBeInTheDocument()
  })

  it('keeps Unpair working for such a peer', async () => {
    const user = userEvent.setup()
    const onUnpair = vi.fn()

    render(<PairingPeersList peers={responderOnly} onUnpair={onUnpair} />)

    await user.click(screen.getByRole('button', { name: /Unpair/i }))
    expect(onUnpair).toHaveBeenCalledWith('peer-responder-only')
  })

  it('has no a11y violations for a responder-only peer', async () => {
    const { container } = render(<PairingPeersList peers={responderOnly} onUnpair={vi.fn()} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

/**
 * #4084 (review) — display and sort order must agree.
 *
 * The prop arrives verbatim from `list_peer_refs`, which ends `ORDER BY
 * synced_at DESC`; SQLite sorts NULLs LAST under DESC, so a responder-only
 * peer (`synced_at IS NULL`, `streamed_at` recent) arrives at the very bottom
 * of the backend's list, interleaved with the peers that genuinely never
 * synced. Rendering that order unchanged showed such a peer "Last: 5m ago"
 * while placing it below a peer labelled "Never synced" — the exact split
 * `comparePeers` exists to close on the device list.
 *
 * These pin the *rendered* order, in backend order, so the component cannot
 * quietly go back to rendering `peers` as given.
 */
describe('PairingPeersList — order matches the last-sync activity it displays (#4084)', () => {
  const row = (over: Partial<PeerRef>): PeerRef => ({
    peer_id: 'peer-x',
    last_hash: null,
    last_sent_hash: null,
    streamed_at: null,
    synced_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
    endpoint_id: null,
    ...over,
  })

  /** The rendered peer ids, top to bottom. */
  const renderedOrder = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('.pairing-peer-item p.font-mono')).map(
      // `title` carries the full id; the visible text is truncated.
      (el) => el.getAttribute('title') ?? '',
    )

  it('lifts a responder-only peer above the genuinely-never-synced ones', () => {
    // Exactly the shape `ORDER BY synced_at DESC` hands us: the one peer with
    // a non-NULL synced_at first, then the NULL-synced_at rows — the
    // responder-only peer buried among them.
    const backendOrder = [
      row({ peer_id: 'peer-pulled-long-ago', synced_at: 1000 }),
      row({ peer_id: 'peer-never-synced', synced_at: null, streamed_at: null }),
      row({ peer_id: 'peer-responder-only', synced_at: null, streamed_at: 9000 }),
    ]

    const { container } = render(<PairingPeersList peers={backendOrder} onUnpair={vi.fn()} />)

    expect(renderedOrder(container)).toEqual([
      'peer-responder-only', // streamed_at 9000 — the most recent activity
      'peer-pulled-long-ago', // synced_at 1000
      'peer-never-synced', // no activity at all
    ])
  })

  it('applies the same named-first rule as the device list', () => {
    const backendOrder = [
      row({ peer_id: 'peer-unnamed', synced_at: 9999 }),
      row({ peer_id: 'peer-named', device_name: 'Pixel 8', synced_at: null }),
    ]

    const { container } = render(<PairingPeersList peers={backendOrder} onUnpair={vi.fn()} />)

    expect(renderedOrder(container)).toEqual(['peer-named', 'peer-unnamed'])
  })

  it('does not mutate the caller-owned peers array', () => {
    const backendOrder = [
      row({ peer_id: 'peer-b', synced_at: null, streamed_at: 9000 }),
      row({ peer_id: 'peer-a', synced_at: 1000 }),
    ]
    const before = backendOrder.map((p) => p.peer_id)

    render(<PairingPeersList peers={backendOrder} onUnpair={vi.fn()} />)

    expect(backendOrder.map((p) => p.peer_id)).toEqual(before)
  })

  it('unpairs the peer whose row was clicked, not the one at that backend index', async () => {
    const user = userEvent.setup()
    const onUnpair = vi.fn()
    const backendOrder = [
      row({ peer_id: 'peer-never-synced', synced_at: null, streamed_at: null }),
      row({ peer_id: 'peer-responder-only', synced_at: null, streamed_at: 9000 }),
    ]

    render(<PairingPeersList peers={backendOrder} onUnpair={onUnpair} />)

    const unpairBtns = screen.getAllByRole('button', { name: /Unpair/i })
    await user.click(unpairBtns[0] as HTMLElement)

    expect(onUnpair).toHaveBeenCalledWith('peer-responder-only')
  })
})
