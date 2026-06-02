/**
 * Tests for NotificationsTab — FEAT-11 Settings slice (#138).
 *
 * Validates:
 *  - Renders the enable toggle (off by default) + permission/test
 *    affordances; the test button is disabled while notifications are off.
 *  - Toggling the switch persists to localStorage under
 *    `agaric-notifications-enabled` and enables the test button.
 *  - "Request permission" calls `ensureNotificationPermission` and toasts
 *    success / denial accordingly, including the throw path.
 *  - "Send test notification" ensures permission then fires `notifyTask`;
 *    skips `notifyTask` and toasts when permission is denied; toasts on
 *    `notifyTask` rejection.
 *  - `axe(container)` a11y audit returns zero violations.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ensureNotificationPermission, notifyTask } from '@/lib/tauri'

import { NotificationsTab } from '../NotificationsTab'

vi.mock('@/lib/tauri', () => ({
  ensureNotificationPermission: vi.fn(),
  notifyTask: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

const mockEnsure = vi.mocked(ensureNotificationPermission)
const mockNotify = vi.mocked(notifyTask)
const ENABLED_KEY = 'agaric-notifications-enabled'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockEnsure.mockResolvedValue(true)
  mockNotify.mockResolvedValue(undefined)
})

afterEach(() => {
  localStorage.clear()
})

describe('NotificationsTab', () => {
  it('renders with notifications off by default; test button disabled', () => {
    render(<NotificationsTab />)
    const toggle = screen.getByTestId('notifications-enabled-switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('notifications-send-test-button')).toBeDisabled()
    expect(screen.getByTestId('notifications-request-permission-button')).toBeEnabled()
  })

  it('toggling persists the preference and enables the test button', async () => {
    const user = userEvent.setup()
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-enabled-switch'))
    await waitFor(() => {
      expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
    })
    expect(JSON.parse(localStorage.getItem(ENABLED_KEY) ?? 'null')).toBe(true)
  })

  it('hydrates the toggle from a persisted preference', () => {
    localStorage.setItem(ENABLED_KEY, 'true')
    render(<NotificationsTab />)
    expect(screen.getByTestId('notifications-enabled-switch')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
  })

  it('request permission: success toasts on grant', async () => {
    const user = userEvent.setup()
    mockEnsure.mockResolvedValue(true)
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(mockEnsure).toHaveBeenCalledTimes(1)
      expect(toast.success).toHaveBeenCalled()
    })
  })

  it('request permission: error toasts on denial', async () => {
    const user = userEvent.setup()
    mockEnsure.mockResolvedValue(false)
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('request permission: error toasts when the call throws', async () => {
    const user = userEvent.setup()
    mockEnsure.mockRejectedValue(new Error('boom'))
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('send test: ensures permission then fires notifyTask', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ENABLED_KEY, 'true')
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-send-test-button'))
    await waitFor(() => {
      expect(mockEnsure).toHaveBeenCalled()
      expect(mockNotify).toHaveBeenCalledTimes(1)
      expect(toast.success).toHaveBeenCalled()
    })
    const arg = mockNotify.mock.calls[0]?.[0]
    expect(arg?.title).toBeTruthy()
  })

  it('send test: skips notifyTask and toasts when permission denied', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ENABLED_KEY, 'true')
    mockEnsure.mockResolvedValue(false)
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-send-test-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('send test: toasts when notifyTask rejects', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ENABLED_KEY, 'true')
    mockNotify.mockRejectedValue(new Error('ipc failed'))
    render(<NotificationsTab />)
    await user.click(screen.getByTestId('notifications-send-test-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<NotificationsTab />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
