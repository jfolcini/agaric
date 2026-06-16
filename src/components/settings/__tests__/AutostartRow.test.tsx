/**
 * Tests for AutostartRow — error-path coverage (#1270).
 *
 * The row wraps the `isAutostartEnabled` / `enableAutostart` /
 * `disableAutostart` IPC. Its toggle is optimistic-update +
 * revert-on-failure: a rejected toggle IPC must revert the visible
 * state AND toast the failure rather than leave the switch lying about
 * the underlying setting. These tests cover that error path plus the
 * "plugin unavailable → row hidden" rejection branch.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutostartRow } from '@/components/settings/AutostartRow'
import { notify } from '@/lib/notify'
import { disableAutostart, enableAutostart, isAutostartEnabled } from '@/lib/tauri'

vi.mock('@/lib/tauri', () => ({
  isAutostartEnabled: vi.fn(),
  enableAutostart: vi.fn(),
  disableAutostart: vi.fn(),
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const mockIsEnabled = vi.mocked(isAutostartEnabled)
const mockEnable = vi.mocked(enableAutostart)
const mockDisable = vi.mocked(disableAutostart)
const mockNotify = vi.mocked(notify)

beforeEach(() => {
  vi.clearAllMocks()
  mockEnable.mockResolvedValue(undefined)
  mockDisable.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AutostartRow', () => {
  it('hides the row when isAutostartEnabled rejects (plugin unavailable)', async () => {
    mockIsEnabled.mockRejectedValueOnce(new Error('plugin missing'))
    const { container } = render(<AutostartRow />)
    // The unavailable branch collapses to `null` → nothing renders.
    await waitFor(() => {
      expect(container.querySelector('#autostart-toggle')).toBeNull()
    })
  })

  it('renders the toggle once isAutostartEnabled resolves', async () => {
    mockIsEnabled.mockResolvedValueOnce(false)
    render(<AutostartRow />)
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeInTheDocument()
    })
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  // #1270 error-path: a rejected toggle IPC must revert the optimistic
  // state AND toast the failure.
  it('reverts state and toasts when enableAutostart rejects', async () => {
    const user = userEvent.setup()
    mockIsEnabled.mockResolvedValueOnce(false)
    mockEnable.mockRejectedValueOnce(new Error('ipc boom'))
    render(<AutostartRow />)

    const toggle = await screen.findByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockEnable).toHaveBeenCalledTimes(1)
      expect(mockNotify.error).toHaveBeenCalled()
    })
    // Optimistic-update reverted: switch is back to off.
    await waitFor(() => {
      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    })
  })
})
