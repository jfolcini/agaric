/**
 * Tests for GcalReauthBanner — MAINT-216.
 *
 * Validates:
 *  - Renders nothing when no event has fired (zero footprint on the
 *    happy path).
 *  - Renders the banner with the account email interpolated into the
 *    body when `gcal:reauth_required` fires with `account_email`.
 *  - Falls back to the generic body when `account_email` is `null`.
 *  - Reconnect button invokes `begin_gcal_oauth` exactly once.
 *  - Banner clears itself when `begin_gcal_oauth` resolves.
 *  - `axe(container)` a11y audit: zero violations.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { GcalReauthBanner } from '../GcalReauthBanner'

// ---------------------------------------------------------------------------
// Tauri event mock — registers listener handlers keyed by event name. Tests
// emit events via `fireGcalEvent(name, payload)` to drive the handler.
// Mirrors the pattern used by GoogleCalendarSettingsTab.test.tsx so the two
// listener tests stay symmetrical.
// ---------------------------------------------------------------------------

type EventHandler = (event: { payload: unknown }) => void
const eventListeners = new Map<string, EventHandler>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: EventHandler) => {
    eventListeners.set(name, handler)
    return () => {
      eventListeners.delete(name)
    }
  }),
}))

function fireGcalEvent(name: string, payload: unknown = null) {
  const handler = eventListeners.get(name)
  if (handler) {
    handler({ payload })
  }
}

// Silence logger output in case the subscription path takes the warn branch.
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  // Default: begin_gcal_oauth resolves successfully so the banner
  // self-clears in the reconnect test path. Per-test overrides via
  // `mockedInvoke.mockImplementationOnce(...)` still work.
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'begin_gcal_oauth') return null
    return undefined
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Inactive state
// ---------------------------------------------------------------------------

describe('GcalReauthBanner — inactive', () => {
  it('renders nothing when no event has fired', async () => {
    const { container } = render(<GcalReauthBanner />)

    // Wait for the listener to register so we know the effect has run.
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('gcal-reauth-banner')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Active state — with email
// ---------------------------------------------------------------------------

describe('GcalReauthBanner — active with email', () => {
  it('renders the banner with the account email when reauth fires', async () => {
    render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: 'user@example.com' })
    })

    const banner = await screen.findByTestId('gcal-reauth-banner')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveAttribute('role', 'alert')
    // Headline + interpolated body
    expect(screen.getByText('Google Calendar disconnected')).toBeInTheDocument()
    expect(screen.getByText(/user@example\.com/)).toBeInTheDocument()
    // Reconnect button is present and enabled.
    const button = screen.getByTestId('gcal-reauth-reconnect-button')
    expect(button).toBeEnabled()
  })
})

// ---------------------------------------------------------------------------
// Active state — null email fallback
// ---------------------------------------------------------------------------

describe('GcalReauthBanner — active without email', () => {
  it('renders the fallback body when account_email is null', async () => {
    render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: null })
    })

    expect(await screen.findByTestId('gcal-reauth-banner')).toBeInTheDocument()
    expect(
      screen.getByText('Reconnect your Google Calendar account to resume sync.'),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Reconnect button — invokes begin_gcal_oauth
// ---------------------------------------------------------------------------

describe('GcalReauthBanner — reconnect button', () => {
  it('invokes begin_gcal_oauth exactly once when clicked', async () => {
    const user = userEvent.setup()
    render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: 'user@example.com' })
    })

    const button = await screen.findByTestId('gcal-reauth-reconnect-button')
    await user.click(button)

    await waitFor(() => {
      const oauthCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'begin_gcal_oauth')
      expect(oauthCalls.length).toBe(1)
    })
  })

  it('clears the banner when begin_gcal_oauth resolves', async () => {
    const user = userEvent.setup()
    render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: 'user@example.com' })
    })

    const button = await screen.findByTestId('gcal-reauth-reconnect-button')
    await user.click(button)

    await waitFor(() => {
      expect(screen.queryByTestId('gcal-reauth-banner')).not.toBeInTheDocument()
    })
  })

  it('keeps the banner up when begin_gcal_oauth rejects (error path)', async () => {
    // AGENTS.md #198: every component calling invoke must have an error-path test.
    // Reconnect rejection → banner stays, user can retry. `useIpcCommand`'s
    // `onError` branch fires `toast.error(t('gcal.connectFailed'))`; we
    // primarily assert that the banner is NOT cleared and the button is
    // re-enabled for retry — the toast itself is owned by sonner.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'begin_gcal_oauth') throw new Error('OAuth dance failed')
      return undefined
    })
    const user = userEvent.setup()
    render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: 'user@example.com' })
    })

    const button = await screen.findByTestId('gcal-reauth-reconnect-button')
    await user.click(button)

    // Wait for the rejected invoke to settle.
    await waitFor(() => {
      const oauthCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'begin_gcal_oauth')
      expect(oauthCalls.length).toBe(1)
    })

    // Banner is still present; button re-enabled so the user can retry.
    expect(screen.getByTestId('gcal-reauth-banner')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('gcal-reauth-reconnect-button')).toBeEnabled()
    })
  })
})

// ---------------------------------------------------------------------------
// A11y
// ---------------------------------------------------------------------------

describe('GcalReauthBanner — a11y', () => {
  it('has no axe violations when active', async () => {
    const { container } = render(<GcalReauthBanner />)
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required', { account_email: 'user@example.com' })
    })

    await screen.findByTestId('gcal-reauth-banner')

    expect(await axe(container)).toHaveNoViolations()
  })
})
