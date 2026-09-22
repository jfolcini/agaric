/**
 * Tests for InternetRelaySetting (#4549).
 *
 * The backend is a mocked `commands` pair over an in-memory settings store,
 * so every assertion is on what the store HOLDS after an interaction, never
 * on the call shape.
 *
 * Validates:
 *  - Renders off by default and hydrates from the stored setting.
 *  - Toggling persists through `setSyncRelaySettings`.
 *  - A rejected save toasts and rolls the switch back to the stored value.
 *  - A rejected load toasts and keeps the default.
 *  - `axe(container)` a11y audit returns zero violations.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { InternetRelaySetting } from '@/components/peers/InternetRelaySetting'

interface Settings {
  enabled: boolean
}

const mockGetSettings = vi.fn()
const mockSetSettings = vi.fn()
vi.mock('@/lib/bindings', () => ({
  commands: {
    getSyncRelaySettings: (...args: unknown[]) => mockGetSettings(...args),
    setSyncRelaySettings: (...args: unknown[]) => mockSetSettings(...args),
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

/** The in-memory `app_settings` row the mocked commands read and write. */
let stored: Settings

beforeEach(() => {
  vi.clearAllMocks()
  stored = { enabled: false }
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
  const result = render(<InternetRelaySetting />)
  await waitFor(() => {
    expect(mockGetSettings).toHaveBeenCalledTimes(1)
  })
  return result
}

describe('InternetRelaySetting', () => {
  it('renders off by default', async () => {
    await renderLoaded()
    expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/takes effect the next time Agaric starts/)).toBeInTheDocument()
  })

  it('hydrates the switch from the stored setting', async () => {
    stored = { enabled: true }
    await renderLoaded()
    await waitFor(() => {
      expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'true')
    })
  })

  it('toggling persists the setting', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(screen.getByTestId('internet-relay-switch'))
    await waitFor(() => {
      expect(stored).toEqual({ enabled: true })
    })
    expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('a rejected save toasts and rolls the switch back', async () => {
    const user = userEvent.setup()
    mockSetSettings.mockRejectedValue(new Error('disk full'))
    await renderLoaded()
    await user.click(screen.getByTestId('internet-relay-switch'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save the internet fallback setting')
    })
    expect(stored).toEqual({ enabled: false })
    expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('a rejected load toasts and keeps the default', async () => {
    mockGetSettings.mockRejectedValue(new Error('db locked'))
    await renderLoaded()
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load the internet fallback setting')
    })
    expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('has no a11y violations', async () => {
    const { container } = await renderLoaded()
    expect(await axe(container)).toHaveNoViolations()
  })
})
