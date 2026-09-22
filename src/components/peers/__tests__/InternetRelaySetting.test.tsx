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

import { act, render, screen, waitFor } from '@testing-library/react'
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

  /** A mocked load the test resolves by hand; `settled` is the promise the
   *  component awaits, so `await act(() => settled)` is a real barrier. */
  function deferredLoad() {
    let resolve: (value: unknown) => void = () => {}
    const settled = new Promise((r) => {
      resolve = r
    })
    mockGetSettings.mockImplementationOnce(() => settled)
    return { resolve, settled }
  }

  it('a toggle made before the initial load resolves is not overwritten by it', async () => {
    const user = userEvent.setup()
    const load = deferredLoad()
    render(<InternetRelaySetting />)
    await user.click(screen.getByTestId('internet-relay-switch'))
    await waitFor(() => {
      expect(stored).toEqual({ enabled: true })
    })
    await act(async () => {
      load.resolve(ok({ enabled: false }))
      await load.settled
    })
    expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('a save rejected after the initial load landed rolls back to the row, not the guess', async () => {
    const user = userEvent.setup()
    stored = { enabled: true }
    const load = deferredLoad()
    let rejectSave: (reason: unknown) => void = () => {}
    mockSetSettings.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    render(<InternetRelaySetting />)
    // Click while the load is pending (the default shows off), let the load
    // land suppressed, then fail the save: the rollback must read the row.
    await user.click(screen.getByTestId('internet-relay-switch'))
    await act(async () => {
      load.resolve(ok({ enabled: true }))
      await load.settled
    })
    await act(async () => {
      rejectSave(new Error('disk full'))
    })
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save the internet fallback setting')
    })
    await waitFor(() => {
      expect(screen.getByTestId('internet-relay-switch')).toHaveAttribute('aria-checked', 'true')
    })
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
