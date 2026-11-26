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
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { disableAutostart, enableAutostart, isAutostartEnabled } from '@/lib/platform/autostart'

vi.mock('@/lib/platform/autostart', () => ({
  isAutostartEnabled: vi.fn(),
  enableAutostart: vi.fn(),
  disableAutostart: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  it('hides the row when the autostart plugin is not registered, and logs it as expected', async () => {
    // The runtime's own rejection for an unregistered plugin (mobile, the browser).
    mockIsEnabled.mockRejectedValueOnce('plugin autostart not found')
    const { container } = render(<AutostartRow />)
    // The unavailable branch collapses to `null` → nothing renders.
    await waitFor(() => {
      expect(logger.debug).toHaveBeenCalledWith(
        'SettingsView',
        'no autostart plugin; hiding launch-on-login row',
      )
    })
    expect(container.querySelector('#autostart-toggle')).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('hides the row on any other rejection, and warns: a desktop IPC failure', async () => {
    const failure = new Error('IPC denied')
    mockIsEnabled.mockRejectedValueOnce(failure)
    const { container } = render(<AutostartRow />)
    await waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'SettingsView',
        'autostart unavailable; hiding launch-on-login row',
        undefined,
        failure,
      )
    })
    expect(container.querySelector('#autostart-toggle')).toBeNull()
    expect(logger.debug).not.toHaveBeenCalled()
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
