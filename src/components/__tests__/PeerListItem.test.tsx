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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PeerRefRow } from '../../lib/tauri'
import { PeerListItem } from '../PeerListItem'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

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

  describe('setPeerAddress error path', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shows error toast when setPeerAddress rejects', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })
      const onAddressUpdated = vi.fn()

      vi.spyOn(window, 'prompt').mockReturnValueOnce('bad-address')
      mockedInvoke.mockRejectedValueOnce(new Error('invalid address format'))

      render(<PeerListItem peer={peer} {...defaultProps} onAddressUpdated={onAddressUpdated} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Invalid address format (expected host:port)',
        )
      })
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
      expect(onAddressUpdated).not.toHaveBeenCalled()
    })

    it('shows success toast and calls onAddressUpdated when setPeerAddress resolves', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })
      const onAddressUpdated = vi.fn()

      vi.spyOn(window, 'prompt').mockReturnValueOnce('192.168.1.1:8080')
      mockedInvoke.mockResolvedValueOnce(undefined)

      render(<PeerListItem peer={peer} {...defaultProps} onAddressUpdated={onAddressUpdated} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Address updated')
      })
      expect(onAddressUpdated).toHaveBeenCalled()
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    })

    it('does not call invoke when prompt is cancelled', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      vi.spyOn(window, 'prompt').mockReturnValueOnce(null)

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    })

    it('does not call invoke when prompt returns empty string', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      vi.spyOn(window, 'prompt').mockReturnValueOnce('')

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      expect(mockedInvoke).not.toHaveBeenCalled()
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    })

    it('passes correct args to set_peer_address invoke call', async () => {
      const user = userEvent.setup()
      const peer = makePeer({ device_name: 'Work Laptop' })

      vi.spyOn(window, 'prompt').mockReturnValueOnce('10.0.0.1:9090')
      mockedInvoke.mockResolvedValueOnce(undefined)

      render(<PeerListItem peer={peer} {...defaultProps} />)

      const editBtn = screen.getByRole('button', { name: /Edit address for Work Laptop/i })
      await user.click(editBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('set_peer_address', {
          peerId: 'peer-abc-1234567890',
          address: '10.0.0.1:9090',
        })
      })
    })
  })
})
