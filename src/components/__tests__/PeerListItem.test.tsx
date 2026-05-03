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
import type { PeerRefRow } from '../../lib/tauri'
import { PeerListItem } from '../PeerListItem'

const mockedInvoke = vi.mocked(invoke)

function makePeer(overrides: Partial<PeerRefRow> = {}): PeerRefRow {
  return {
    peer_id: 'peer-abc-1234567890',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
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
      // the server rejects (UX-378: client validation now blocks
      // malformed input before it reaches the IPC; this exercises
      // the defense-in-depth toast path for server-side rejections).
      const input = screen.getByLabelText('Address (host:port)')
      await user.clear(input)
      await user.type(input, '192.168.1.1:5000')
      await user.click(screen.getByRole('button', { name: /Save/i }))

      await waitFor(() => {
        // UX-12: toast now embeds the format example so the user
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

  // ── UX-12: address popover Cancel button + format hint typography ───
  describe('address popover Cancel button + format hint (UX-12)', () => {
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

    it('renders the format hint at text-xs (12px) — bumped from text-[10px]', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      const { container } = render(<PeerListItem peer={peer} {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: /Edit address for Work Laptop/i }))

      // Hint copy embeds the format example so the user doesn't have to guess.
      const hint = await screen.findByText(/Format: host:port/)
      expect(hint).toBeInTheDocument()
      expect(hint.textContent).toContain('192.168.1.100:5000')

      // Hint must use text-xs, not the old text-[10px].
      expect(hint.className).toContain('text-xs')
      expect(hint.className).not.toContain('text-[10px]')

      // axe audit with popover open.
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── UX-378: real-time inline format validation ──────────────────────
  describe('address popover inline format validation (UX-378)', () => {
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
})
