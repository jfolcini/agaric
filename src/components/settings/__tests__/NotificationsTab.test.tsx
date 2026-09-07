/**
 * Tests for NotificationsTab — Settings slice (#138, reminders #4554).
 *
 * The backend is a mocked `commands` pair over an in-memory settings store,
 * so every assertion is on what the store HOLDS after an interaction, never
 * on the call shape.
 *
 * Validates:
 *  - Renders from the loaded settings (off / 09:00 by default): the test
 *    button and the time input are disabled while reminders are off.
 *  - Toggling the switch persists `enabled` through `setReminderSettings`
 *    and enables the test button and the time input.
 *  - A whole `HH:MM` time persists; an incomplete value does not.
 *  - A rejected save toasts and rolls the UI back to the stored value.
 *  - A rejected load toasts and keeps the defaults.
 *  - "Request permission" / "Send test notification" behave as before.
 *  - `axe(container)` a11y audit returns zero violations.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { NotificationsTab } from '@/components/settings/NotificationsTab'
import { ensureNotificationPermission } from '@/lib/platform/notifications'

vi.mock('@/lib/platform/notifications', () => ({
  ensureNotificationPermission: vi.fn(),
}))

interface Settings {
  enabled: boolean
  time: string
}

const mockNotifyTask = vi.fn()
const mockGetSettings = vi.fn()
const mockSetSettings = vi.fn()
vi.mock('@/lib/bindings', () => ({
  commands: {
    notifyTask: (...args: unknown[]) => mockNotifyTask(...args),
    getReminderSettings: (...args: unknown[]) => mockGetSettings(...args),
    setReminderSettings: (...args: unknown[]) => mockSetSettings(...args),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

const mockEnsure = vi.mocked(ensureNotificationPermission)
const mockNotify = mockNotifyTask

/** The in-memory `app_settings` the mocked commands read and write. */
let stored: Settings

beforeEach(() => {
  vi.clearAllMocks()
  stored = { enabled: false, time: '09:00' }
  mockEnsure.mockResolvedValue(true)
  mockNotify.mockResolvedValue(ok(null))
  mockGetSettings.mockImplementation(() => Promise.resolve(ok({ ...stored })))
  mockSetSettings.mockImplementation((next: Settings) => {
    stored = { ...next }
    return Promise.resolve(ok(null))
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

async function renderLoaded() {
  const result = render(<NotificationsTab />)
  await waitFor(() => {
    expect(mockGetSettings).toHaveBeenCalledTimes(1)
  })
  return result
}

describe('NotificationsTab', () => {
  it('renders with reminders off by default; test button and time input disabled', async () => {
    await renderLoaded()
    const toggle = screen.getByTestId('notifications-enabled-switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('notifications-send-test-button')).toBeDisabled()
    expect(screen.getByTestId('notifications-reminder-time')).toBeDisabled()
    expect(screen.getByTestId('notifications-reminder-time')).toHaveValue('09:00')
    expect(screen.getByTestId('notifications-request-permission-button')).toBeEnabled()
  })

  it('toggling persists the switch and enables the test button and time input', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(screen.getByTestId('notifications-enabled-switch'))
    await waitFor(() => {
      expect(stored).toEqual({ enabled: true, time: '09:00' })
    })
    expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
    expect(screen.getByTestId('notifications-reminder-time')).toBeEnabled()
  })

  it('hydrates the switch and time from the stored settings', async () => {
    stored = { enabled: true, time: '18:30' }
    await renderLoaded()
    await waitFor(() => {
      expect(screen.getByTestId('notifications-enabled-switch')).toHaveAttribute(
        'aria-checked',
        'true',
      )
    })
    expect(screen.getByTestId('notifications-reminder-time')).toHaveValue('18:30')
    expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
  })

  it('a whole HH:MM time persists; an incomplete value does not', async () => {
    stored = { enabled: true, time: '09:00' }
    await renderLoaded()
    const input = screen.getByTestId('notifications-reminder-time')
    fireEvent.change(input, { target: { value: '' } })
    expect(stored.time).toBe('09:00')
    fireEvent.change(input, { target: { value: '07:15' } })
    await waitFor(() => {
      expect(stored).toEqual({ enabled: true, time: '07:15' })
    })
    expect(input).toHaveValue('07:15')
  })

  it('a rejected save toasts and rolls the switch back', async () => {
    const user = userEvent.setup()
    mockSetSettings.mockRejectedValue(new Error('ipc failed'))
    await renderLoaded()
    await user.click(screen.getByTestId('notifications-enabled-switch'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(stored.enabled).toBe(false)
    expect(screen.getByTestId('notifications-enabled-switch')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('a rejected load toasts and keeps the defaults', async () => {
    mockGetSettings.mockRejectedValue(new Error('ipc failed'))
    render(<NotificationsTab />)
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(screen.getByTestId('notifications-enabled-switch')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByTestId('notifications-reminder-time')).toHaveValue('09:00')
  })

  it('request permission: success toasts on grant', async () => {
    const user = userEvent.setup()
    mockEnsure.mockResolvedValue(true)
    await renderLoaded()
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(mockEnsure).toHaveBeenCalledTimes(1)
      expect(toast.success).toHaveBeenCalled()
    })
  })

  it('request permission: error toasts on denial', async () => {
    const user = userEvent.setup()
    mockEnsure.mockResolvedValue(false)
    await renderLoaded()
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('request permission: error toasts when the call throws', async () => {
    const user = userEvent.setup()
    mockEnsure.mockRejectedValue(new Error('boom'))
    await renderLoaded()
    await user.click(screen.getByTestId('notifications-request-permission-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('send test: ensures permission then fires notifyTask', async () => {
    const user = userEvent.setup()
    stored = { enabled: true, time: '09:00' }
    await renderLoaded()
    await waitFor(() => {
      expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
    })
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
    stored = { enabled: true, time: '09:00' }
    mockEnsure.mockResolvedValue(false)
    await renderLoaded()
    await waitFor(() => {
      expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
    })
    await user.click(screen.getByTestId('notifications-send-test-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('send test: toasts when notifyTask rejects', async () => {
    const user = userEvent.setup()
    stored = { enabled: true, time: '09:00' }
    mockNotify.mockRejectedValue(new Error('ipc failed'))
    await renderLoaded()
    await waitFor(() => {
      expect(screen.getByTestId('notifications-send-test-button')).toBeEnabled()
    })
    await user.click(screen.getByTestId('notifications-send-test-button'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = await renderLoaded()
    expect(await axe(container)).toHaveNoViolations()
  })
})
