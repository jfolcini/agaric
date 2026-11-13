/**
 * Tests for LocalSyncAddress (#6526): the row shows what the daemon bound,
 * says so when that is only loopback, and stays out of the way otherwise.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { LocalSyncAddress } from '@/components/peers/LocalSyncAddress'
import { logger } from '@/lib/logger'

const mockGetAddress = vi.fn()
vi.mock('@/lib/bindings', () => ({
  commands: {
    getLocalSyncAddress: (...args: unknown[]) => mockGetAddress(...args),
  },
}))

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LocalSyncAddress', () => {
  it('shows the address the sync endpoint is bound to', async () => {
    mockGetAddress.mockResolvedValue(ok({ address: '192.168.1.20:41234', loopback: false }))
    const { container } = render(<LocalSyncAddress />)

    expect(await screen.findByTestId('local-sync-address')).toHaveTextContent('192.168.1.20:41234')
    expect(screen.getByText("This device's address")).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('says there is no local network instead of showing a loopback address', async () => {
    mockGetAddress.mockResolvedValue(ok({ address: '127.0.0.1:41234', loopback: true }))
    const { container } = render(<LocalSyncAddress />)

    expect(await screen.findByText(/No local network/)).toBeInTheDocument()
    expect(screen.queryByText(/127\.0\.0\.1/)).not.toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('renders nothing while the daemon has bound no endpoint', async () => {
    mockGetAddress.mockResolvedValue(ok(null))
    const { container } = render(<LocalSyncAddress />)

    await waitFor(() => {
      expect(mockGetAddress).toHaveBeenCalledTimes(1)
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('logs a rejected read and renders nothing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockGetAddress.mockRejectedValue(new Error('ipc down'))
    const { container } = render(<LocalSyncAddress />)

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'LocalSyncAddress',
        'getLocalSyncAddress() rejected',
        undefined,
        expect.any(Error),
      )
    })
    expect(container).toBeEmptyDOMElement()
  })
})
