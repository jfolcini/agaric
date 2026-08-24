/**
 * Tests for PeerListItem component.
 *
 * Validates:
 *  - Renders peer name and status
 *  - Renders truncated peer ID when no device name
 *  - Sync button click calls onSyncNow
 *  - Unpair button click calls onUnpair
 *  - Accessibility (axe audit)
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PeerListItem } from '@/components/peers/PeerListItem'
import type { PeerRef } from '@/lib/tauri'

const mockedInvoke = vi.mocked(invoke)

function makePeer(overrides: Partial<PeerRef> = {}): PeerRef {
  return {
    peer_id: 'peer-abc-1234567890',
    last_hash: null,
    last_sent_hash: null,
    streamed_at: null,
    synced_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    remote_device_name: null,
    last_address: null,
    endpoint_id: null,
    unpaired_by_peer_at_ms: null,
    ...overrides,
  }
}

const defaultProps = {
  syncingPeerId: null,
  syncingAll: false,
  renamingPeerId: null,
  onSyncNow: vi.fn(),
  onUnpair: vi.fn(),
  onRename: vi.fn(),
  onAddressUpdated: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
})

describe('PeerListItem', () => {
  it('renders peer name and status', () => {
    const peer = makePeer({
      device_name: 'Work Laptop',
      remote_device_name: null,
      synced_at: null,
    })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('Work Laptop')).toBeInTheDocument()
    expect(screen.getByText(/Last:.*Never synced/)).toBeInTheDocument()
  })

  it('renders truncated peer ID when no device name', () => {
    const peer = makePeer({ device_name: null })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
  })

  // ── #4298: the display precedence ────────────────────────────────

  it('renders the name the peer supplied when the user has set no override (#4298)', () => {
    // The reported bug: a freshly paired peer had no name anywhere, so the row
    // rendered `truncateId(peer_id)` — `e3d48f0a-45a…` — and stayed that way
    // until the user renamed it by hand on this device AND on the other one.
    const peer = makePeer({ device_name: null, remote_device_name: 'javier-thinkpad' })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('javier-thinkpad')).toBeInTheDocument()
    expect(screen.getByText('peer-abc-123...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Rename.*javier-thinkpad/i })).toBeInTheDocument()
  })

  it('lets the user override outrank the name the peer supplied (#4298)', () => {
    const peer = makePeer({ device_name: 'Work Laptop', remote_device_name: 'javier-thinkpad' })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('Work Laptop')).toBeInTheDocument()
    expect(screen.queryByText('javier-thinkpad')).not.toBeInTheDocument()
  })

  it('falls back to the truncated id only when neither name exists (#4298)', () => {
    const peer = makePeer({ device_name: null, remote_device_name: null })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    // The id is the NAME line here, so it appears exactly once — the separate
    // id subtitle is suppressed rather than repeating it.
    expect(screen.getAllByText('peer-abc-123...')).toHaveLength(1)
  })

  it('treats a blank name as no name at all (#4298)', () => {
    // `update_peer_name` is a local command and the wire value is normalised
    // backend-side, but a blank must never render as an empty row heading.
    const peer = makePeer({ device_name: '   ', remote_device_name: 'javier-thinkpad' })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('javier-thinkpad')).toBeInTheDocument()
  })

  it('calls onSyncNow when sync button is clicked', async () => {
    const user = userEvent.setup()
    const onSyncNow = vi.fn()
    const peer = makePeer()

    render(<PeerListItem peer={peer} {...defaultProps} onSyncNow={onSyncNow} />)

    const syncBtn = screen.getByRole('button', { name: /Sync Now/i })
    await user.click(syncBtn)

    expect(onSyncNow).toHaveBeenCalledWith('peer-abc-1234567890')
  })

  it('calls onUnpair when unpair button is clicked', async () => {
    const user = userEvent.setup()
    const onUnpair = vi.fn()
    const peer = makePeer()

    render(<PeerListItem peer={peer} {...defaultProps} onUnpair={onUnpair} />)

    const unpairBtn = screen.getByRole('button', { name: /Unpair/i })
    await user.click(unpairBtn)

    expect(onUnpair).toHaveBeenCalledWith('peer-abc-1234567890')
  })

  it('disables sync button when syncing this peer', () => {
    const peer = makePeer()

    render(<PeerListItem peer={peer} {...defaultProps} syncingPeerId="peer-abc-1234567890" />)

    const syncBtn = screen.getByRole('button', { name: /Sync Now/i })
    expect(syncBtn).toBeDisabled()
  })

  it('shows reset count badge', () => {
    const peer = makePeer({ reset_count: 3 })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText('3 resets')).toBeInTheDocument()
  })

  // #2058: reset-count badge uses the i18next plural key (device.resetCount),
  // not hand-rolled `!== 1 ? 's' : ''` pluralization.
  it('uses the device.resetCount _one form for a single reset', () => {
    const peer = makePeer({ reset_count: 1 })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    // _one form: '1 reset' (singular), not '1 resets'
    expect(screen.getByText('1 reset')).toBeInTheDocument()
    expect(screen.queryByText('1 resets')).not.toBeInTheDocument()
  })

  // #2058: 'Last:' prefix comes from device.lastSyncedAt with the relative
  // time interpolated, not a hardcoded English literal.
  it('renders last-synced time via the interpolated device.lastSyncedAt key', () => {
    const peer = makePeer({
      device_name: 'Work Laptop',
      remote_device_name: null,
      synced_at: Date.now() - 5 * 60 * 1000,
    })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    // t('device.lastSyncedAt', { time: '5m ago' }) === 'Last: 5m ago'
    expect(screen.getByText(/Last: 5m ago/)).toBeInTheDocument()
  })

  // #4297 — the other device unpaired, which sends nothing over the wire, so
  // the only evidence is that every dial is now refused. The row must stop
  // reading as healthy, and the `Last:` line must go: it counts from the last
  // session that WORKED, so a pairing dead for a week still reads "Last: 6
  // days ago" beside a device that will never sync again.
  describe('a peer that has unpaired us (#4297)', () => {
    const FIVE_MINUTES_AGO = Date.now() - 5 * 60 * 1000
    const TWO_MINUTES_AGO = Date.now() - 2 * 60 * 1000

    it('replaces the stale last-synced line with a destructive pairing-lost state', () => {
      const peer = makePeer({
        device_name: 'Work Laptop',
        remote_device_name: null,
        synced_at: FIVE_MINUTES_AGO,
        unpaired_by_peer_at_ms: TWO_MINUTES_AGO,
      })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      expect(screen.getByText('Pairing lost')).toBeInTheDocument()
      expect(
        screen.getByText('The other device unpaired from this one. Pair again to resume syncing.'),
      ).toBeInTheDocument()

      // The lie is gone: no 'Last: 5m ago' anywhere on the row.
      expect(screen.queryByText(/Last:/)).not.toBeInTheDocument()

      // …and the timestamp that IS shown is the one that stays true — when we
      // found out, not when we last succeeded.
      expect(screen.getByText('Stopped syncing 2m ago')).toBeInTheDocument()
    })

    it('announces the dead pairing to assistive technology', () => {
      const peer = makePeer({
        device_name: 'Work Laptop',
        remote_device_name: null,
        synced_at: FIVE_MINUTES_AGO,
        unpaired_by_peer_at_ms: TWO_MINUTES_AGO,
      })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      expect(screen.getByRole('alert')).toHaveTextContent(
        'The other device unpaired from this one. Pair again to resume syncing.',
      )
    })

    // The asymmetry the backend enforces has to survive to the UI: a healthy
    // peer must be untouched by this, or every row would carry the warning.
    it('leaves a healthy peer rendering its last-synced time', () => {
      const peer = makePeer({
        device_name: 'Work Laptop',
        remote_device_name: null,
        synced_at: FIVE_MINUTES_AGO,
        unpaired_by_peer_at_ms: null,
      })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      expect(screen.getByText(/Last: 5m ago/)).toBeInTheDocument()
      expect(screen.queryByText('Pairing lost')).not.toBeInTheDocument()
    })

    it('has no a11y violations in the pairing-lost state', async () => {
      const peer = makePeer({
        device_name: 'Work Laptop',
        remote_device_name: null,
        synced_at: FIVE_MINUTES_AGO,
        unpaired_by_peer_at_ms: TWO_MINUTES_AGO,
      })

      const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  it('has no a11y violations', async () => {
    const peer = makePeer({ device_name: 'Test Device' })

    const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  describe('setPeerAddress via popover', () => {
    it('shows error toast when setPeerAddress rejects', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })
      const onAddressUpdated = vi.fn()

      mockedInvoke.mockRejectedValueOnce(new Error('invalid address format'))

      render(<PeerListItem peer={peer} {...defaultProps} onAddressUpdated={onAddressUpdated} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      // Popover is now open — type a syntactically valid address that
      // The server rejects (client validation now blocks
      // malformed input before it reaches the IPC; this exercises
      // the defense-in-depth toast path for server-side rejections).
      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '192.168.1.1:5000')
      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        // Toast now embeds the format example so the user
        // doesn't have to reopen the popover hint to recover.
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Invalid address format. Expected host:port (e.g., 192.168.1.100:5000).',
        )
      })
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
      expect(onAddressUpdated).not.toHaveBeenCalled()
    })

    it('shows success toast and calls onAddressUpdated when address is saved', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })
      const onAddressUpdated = vi.fn()

      mockedInvoke.mockResolvedValueOnce(undefined)

      render(<PeerListItem peer={peer} {...defaultProps} onAddressUpdated={onAddressUpdated} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '192.168.1.1:8080')
      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Address updated')
      })
      expect(onAddressUpdated).toHaveBeenCalled()
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('does not call invoke when popover is closed without saving', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      // Popover opened but user doesn't save — press Escape
      await user.keyboard('{Escape}')

      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('save button is disabled with empty input', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)

      const saveBtn = screen.getByRole('button', { name: /Save/i })
      expect(saveBtn).toBeDisabled()
    })

    it('passes correct args to set_peer_address invoke call', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      mockedInvoke.mockResolvedValueOnce(undefined)

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '10.0.0.1:9090')
      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_peer_address', {
          peerId: 'peer-abc-1234567890',
          address: '10.0.0.1:9090',
        })
      })
    })
  })

  // ── address popover Cancel button + format hint typography ───
  describe('address popover Cancel button + format hint', () => {
    it('renders a Cancel button that closes the popover without invoking IPC', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      // Type something so the popover has unsaved state.
      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '10.0.0.5:5000')

      const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
      expect(cancelBtn).toBeInTheDocument()
      await user.click(cancelBtn)

      // Popover content unmounts after Cancel: input is gone.
      await waitFor(() => {
        expect(screen.queryByLabelText('Address (host:port)')).not.toBeInTheDocument()
      })
      expect(mockedInvoke).not.toHaveBeenCalled()
    })

    it('renders the format hint at text-xs (12px) — bumped from text-xs', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      // Hint copy embeds the format example so the user doesn't have to guess.
      const hint = await screen.findByText(/Format: host:port/)
      expect(hint).toBeInTheDocument()
      expect(hint.textContent).toContain('192.168.1.100:5000')

      // Hint must use text-xs, not the old text-xs.
      expect(hint.className).toContain('text-xs')
      expect(hint.className).not.toContain('text-[10px]')

      // axe audit with popover open.
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── real-time inline format validation ──────────────────────
  describe('address popover inline format validation', () => {
    it('shows no inline error for empty input and disables Save', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled()
    })

    it('shows no inline error and enables Save for valid host:port', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '192.168.1.100:5000')

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: /Save/i })).toBeEnabled()
    })

    it('shows format error and disables Save for malformed input', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, 'notahost')

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Format must be host:port (e.g., 192.168.1.100:5000)')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAttribute('aria-describedby', 'peer-address-error')
      expect(alert).toHaveAttribute('id', 'peer-address-error')
      expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled()
    })

    it('shows port error and disables Save when port is out of range', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '192.168.1.100:99999')

      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Port must be between 1 and 65535')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled()
    })
  })

  it('has no a11y violations with address popover open', async () => {
    const user = userEvent.setup()
    const peer = makePeer({ device_name: 'Test Device' })

    const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)

    await user.click(screen.getByRole('button', { name: /Edit address/i }))

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // PopoverContent must carry an aria-label so screen readers
  // announce the popover purpose, not a generic "dialog".
  describe('address popover aria-label', () => {
    it('labels the open popover with device.editAddressPopoverLabel', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      expect(await screen.findByRole('dialog', { name: 'Edit peer address' })).toBeInTheDocument()
    })

    it('axe is clean with the address popover open', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))
      // Wait for the portalled PopoverContent so axe runs against a settled DOM.
      await screen.findByRole('dialog', { name: 'Edit peer address' })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // The IP-address Input inside the popover is placeholder-only
  // by default. Placeholders disappear on focus and are not exposed as the
  // accessible name in every SR. The Input must carry a non-empty
  // aria-label sourced from i18n.
  describe('address input aria-label', () => {
    it('labels the IP-address input with device.addressInputLabel', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      render(<PeerListItem peer={peer} {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      const input = await screen.findByRole('textbox', { name: 'Address (host:port)' })
      expect(input).toBeInTheDocument()
      expect(input.getAttribute('aria-label')).toBeTruthy()
    })
  })
})

/**
 * #4084 — a responder-only device must not read as "never synced".
 *
 * A sync session is one-directional and #610 deliberately forbids the
 * streamer advancing `synced_at`, so a device that only ever succeeds as
 * RESPONDER leaves that column NULL forever while syncing perfectly. The row
 * renders `MAX(synced_at, streamed_at)` instead.
 */
describe('PeerListItem — last-sync activity (#4084)', () => {
  it('shows a relative time for a peer that has only ever been streamed to', () => {
    const peer = makePeer({
      device_name: 'Android Phone',
      remote_device_name: null,
      synced_at: null,
      streamed_at: Date.now() - 5 * 60 * 1000,
    })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.queryByText(/Never synced/)).not.toBeInTheDocument()
    expect(screen.getByText(/Last:/)).toBeInTheDocument()
  })

  it('still shows "never synced" when neither direction has ever run', () => {
    const peer = makePeer({ device_name: 'Fresh Pair', synced_at: null, streamed_at: null })

    render(<PeerListItem peer={peer} {...defaultProps} />)

    expect(screen.getByText(/Last:.*Never synced/)).toBeInTheDocument()
  })

  it('remains interactive and a11y-clean for a responder-only peer', async () => {
    const user = userEvent.setup()
    const onSyncNow = vi.fn()
    const peer = makePeer({
      device_name: 'Android Phone',
      remote_device_name: null,
      synced_at: null,
      streamed_at: Date.now() - 60_000,
    })

    const { container } = render(
      <PeerListItem peer={peer} {...defaultProps} onSyncNow={onSyncNow} />,
    )

    await user.click(screen.getByRole('button', { name: /Sync Now/i }))
    expect(onSyncNow).toHaveBeenCalledWith('peer-abc-1234567890')

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
