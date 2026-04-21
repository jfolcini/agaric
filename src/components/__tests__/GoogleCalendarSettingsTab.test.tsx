/**
 * Tests for GoogleCalendarSettingsTab — FEAT-5f Settings tab.
 *
 * Validates:
 *  - Happy-path render: all sections visible (experimental badge,
 *    account, window size, privacy, status panel, actions).
 *  - Disconnected state shows Connect button and no account email.
 *  - Connected state shows email + Disconnect button.
 *  - Window-size input: renders current value; typing + blur calls
 *    `set_gcal_window_days`; out-of-range values are clamped client-side.
 *  - Privacy Switch: toggling calls `set_gcal_privacy_mode` with the
 *    correct `{ mode }`.
 *  - Force full resync: click → `invoke('force_gcal_resync')` exactly
 *    once; spinner shown; success toast on resolve.
 *  - Disconnect dialog: opens, and each of the 3 buttons (keep /
 *    delete / cancel) dispatches the correct IPC (or none, for cancel).
 *  - 60 s status polling: re-fetches via `get_gcal_status`.
 *  - Event stream: each of the 4 Tauri events surfaces the correct
 *    toast / re-fetch.
 *  - IPC rejection on every invoke: component logs via `logger.error`,
 *    shows a toast, and does not crash.
 *  - `axe(container)` a11y audit: zero violations.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { logger } from '@/lib/logger'
import { GoogleCalendarSettingsTab } from '../GoogleCalendarSettingsTab'

// ---------------------------------------------------------------------------
// Tauri event mock — registers listener handlers keyed by event name. Tests
// emit events via `fireGcalEvent(name)` to drive the handler.
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

// ---------------------------------------------------------------------------
// Logger spy — exercises error-path logging without polluting console.
// ---------------------------------------------------------------------------

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
const mockedToastInfo = vi.mocked(toast.info)
const mockedLoggerError = vi.mocked(logger.error)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import type { GcalStatus } from '@/lib/bindings'

function makeStatus(overrides: Partial<GcalStatus> = {}): GcalStatus {
  return {
    enabled: true,
    connected: true,
    account_email: 'user@example.com',
    calendar_id: 'agaric-agenda-cal-id',
    window_days: 30,
    privacy_mode: 'full',
    last_push_at: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 min ago
    last_error: null,
    push_lease: {
      held_by_this_device: true,
      device_id: 'this-device',
      expires_at: new Date(Date.now() + 180_000).toISOString(),
    },
    ...overrides,
  }
}

function makeDisconnectedStatus(): GcalStatus {
  return {
    enabled: false,
    connected: false,
    account_email: null,
    calendar_id: null,
    window_days: 30,
    privacy_mode: 'full',
    last_push_at: null,
    last_error: null,
    push_lease: { held_by_this_device: false, device_id: null, expires_at: null },
  }
}

/**
 * Default invoke mock. `get_gcal_status` returns the given status on
 * every call; all mutating commands resolve to `null`.
 */
function setupInvoke(status: GcalStatus) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_gcal_status') return status
    if (cmd === 'set_gcal_window_days') return null
    if (cmd === 'set_gcal_privacy_mode') return null
    if (cmd === 'force_gcal_resync') return null
    if (cmd === 'disconnect_gcal') return null
    if (cmd === 'begin_gcal_oauth') return null
    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Happy-path rendering
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — rendering', () => {
  it('renders every section once the status loads', async () => {
    setupInvoke(makeStatus())

    render(<GoogleCalendarSettingsTab />)

    // Header + experimental warning
    expect(await screen.findByText('Google Calendar')).toBeInTheDocument()
    expect(screen.getByText('Experimental')).toBeInTheDocument()
    expect(
      screen.getByText(/Experimental \u2014 sends your daily agenda to Google Calendar/i),
    ).toBeInTheDocument()

    // Account section (connected)
    expect(screen.getByTestId('gcal-account-email')).toHaveTextContent('user@example.com')
    expect(screen.getByText(/Pushing to calendar: Agaric Agenda/i)).toBeInTheDocument()

    // Window input
    expect(screen.getByTestId('gcal-window-input')).toHaveValue(30)

    // Privacy toggle
    const privacy = screen.getByRole('switch', { name: /Hide agenda content/i })
    expect(privacy).toHaveAttribute('aria-checked', 'false')

    // Status panel
    expect(screen.getByTestId('gcal-status-panel')).toBeInTheDocument()
    expect(screen.getByTestId('gcal-lease-this-device')).toHaveTextContent('This device')

    // Actions
    expect(screen.getByRole('button', { name: /Force full resync/i })).toBeInTheDocument()
    expect(screen.getByTestId('gcal-disconnect-button')).toBeInTheDocument()
  })

  it('renders loading skeleton before status loads', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
    const { container } = render(<GoogleCalendarSettingsTab />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders a degraded fallback UI when get_gcal_status rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') throw new Error('backend down')
      return undefined
    })

    render(<GoogleCalendarSettingsTab />)

    expect(await screen.findByText('Failed to load Google Calendar status')).toBeInTheDocument()
    // Component still renders the rest of the UI
    expect(screen.getByText('Google Calendar')).toBeInTheDocument()
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'GoogleCalendarSettingsTab',
      'failed to load gcal status',
      undefined,
      expect.any(Error),
    )
  })

  it('has no axe violations', async () => {
    setupInvoke(makeStatus())
    const { container } = render(<GoogleCalendarSettingsTab />)
    await screen.findByText('Google Calendar')
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// ---------------------------------------------------------------------------
// Disconnected / connected account states
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — account states', () => {
  it('shows Connect button and no email when disconnected', async () => {
    setupInvoke(makeDisconnectedStatus())
    render(<GoogleCalendarSettingsTab />)

    expect(
      await screen.findByRole('button', { name: /Connect Google Account/i }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('gcal-account-email')).not.toBeInTheDocument()
  })

  it('shows email + Disconnect button when connected', async () => {
    setupInvoke(makeStatus({ account_email: 'me@example.org' }))
    render(<GoogleCalendarSettingsTab />)

    expect(await screen.findByTestId('gcal-account-email')).toHaveTextContent('me@example.org')
    // There are two "Disconnect" buttons (the account header one + the
    // action row) — both should be present.
    expect(screen.getAllByLabelText(/Disconnect/i).length).toBeGreaterThanOrEqual(2)
  })

  it('invokes begin_gcal_oauth when the Connect button is clicked', async () => {
    const user = userEvent.setup()
    setupInvoke(makeDisconnectedStatus())
    render(<GoogleCalendarSettingsTab />)

    const connectBtn = await screen.findByRole('button', { name: /Connect Google Account/i })
    await user.click(connectBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('begin_gcal_oauth')
    })
  })

  it('logs + toasts when begin_gcal_oauth rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeDisconnectedStatus()
      if (cmd === 'begin_gcal_oauth') throw new Error('oauth blew up')
      return undefined
    })

    render(<GoogleCalendarSettingsTab />)
    const connectBtn = await screen.findByRole('button', { name: /Connect Google Account/i })
    await user.click(connectBtn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'GoogleCalendarSettingsTab',
        'failed to begin gcal oauth',
        undefined,
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to start Google sign-in')
  })
})

// ---------------------------------------------------------------------------
// Window-size input
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — window size', () => {
  it('initial render uses status.window_days', async () => {
    setupInvoke(makeStatus({ window_days: 45 }))
    render(<GoogleCalendarSettingsTab />)

    const input = await screen.findByTestId('gcal-window-input')
    expect(input).toHaveValue(45)
  })

  it('typing a valid value + blur calls set_gcal_window_days', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ window_days: 30 }))
    render(<GoogleCalendarSettingsTab />)

    const input = (await screen.findByTestId('gcal-window-input')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '45')
    // Blur flushes immediately (bypasses debounce for deterministic tests).
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_gcal_window_days', { n: 45 })
    })
  })

  it('clamps below-minimum values to 7 on blur', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ window_days: 30 }))
    render(<GoogleCalendarSettingsTab />)

    const input = (await screen.findByTestId('gcal-window-input')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '5')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_gcal_window_days', { n: 7 })
    })
    expect(input.value).toBe('7')
  })

  it('clamps above-maximum values to 90 on blur', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ window_days: 30 }))
    render(<GoogleCalendarSettingsTab />)

    const input = (await screen.findByTestId('gcal-window-input')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '100')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_gcal_window_days', { n: 90 })
    })
    expect(input.value).toBe('90')
  })

  it('logs + toasts when set_gcal_window_days rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeStatus({ window_days: 30 })
      if (cmd === 'set_gcal_window_days') throw new Error('store full')
      return undefined
    })
    render(<GoogleCalendarSettingsTab />)

    const input = (await screen.findByTestId('gcal-window-input')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '45')
    await user.tab()

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'GoogleCalendarSettingsTab',
        'failed to set window days',
        { n: 45 },
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to save window size')
  })
})

// ---------------------------------------------------------------------------
// Privacy toggle
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — privacy toggle', () => {
  it('toggling from full to minimal calls set_gcal_privacy_mode({ mode: "minimal" })', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ privacy_mode: 'full' }))
    render(<GoogleCalendarSettingsTab />)

    const toggle = await screen.findByRole('switch', { name: /Hide agenda content/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_gcal_privacy_mode', { mode: 'minimal' })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith('Privacy mode updated')
  })

  it('toggling from minimal to full calls set_gcal_privacy_mode({ mode: "full" })', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus({ privacy_mode: 'minimal' }))
    render(<GoogleCalendarSettingsTab />)

    const toggle = await screen.findByRole('switch', { name: /Hide agenda content/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_gcal_privacy_mode', { mode: 'full' })
    })
  })

  it('rolls back the toggle + toasts on IPC rejection', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeStatus({ privacy_mode: 'full' })
      if (cmd === 'set_gcal_privacy_mode') throw new Error('backend fail')
      return undefined
    })
    render(<GoogleCalendarSettingsTab />)

    const toggle = await screen.findByRole('switch', { name: /Hide agenda content/i })
    await user.click(toggle)

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'GoogleCalendarSettingsTab',
      'failed to set privacy mode',
      { mode: 'minimal' },
      expect.any(Error),
    )
    expect(mockedToastError).toHaveBeenCalledWith('Failed to update privacy mode')
  })
})

// ---------------------------------------------------------------------------
// Force full resync
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — force resync', () => {
  it('invokes force_gcal_resync exactly once on click', async () => {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)

    const btn = await screen.findByTestId('gcal-resync-button')
    await user.click(btn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('force_gcal_resync')
    })
    const resyncCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'force_gcal_resync')
    expect(resyncCalls).toHaveLength(1)
    expect(mockedToastSuccess).toHaveBeenCalledWith('Full resync started')
  })

  it('shows spinner + aria-busy while the resync is in flight', async () => {
    const user = userEvent.setup()
    let resolveResync: (() => void) | null = null
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeStatus()
      if (cmd === 'force_gcal_resync') {
        return new Promise<void>((resolve) => {
          resolveResync = resolve
        })
      }
      return undefined
    })

    render(<GoogleCalendarSettingsTab />)
    const btn = await screen.findByTestId('gcal-resync-button')
    await user.click(btn)

    // aria-busy flips on while pending
    await waitFor(() => {
      expect(btn).toHaveAttribute('aria-busy', 'true')
    })
    expect(btn.querySelector('[data-slot="spinner"]')).not.toBeNull()

    // Resolve and verify cleanup
    act(() => {
      resolveResync?.()
    })
    await waitFor(() => {
      expect(btn).toHaveAttribute('aria-busy', 'false')
    })
  })

  it('logs + toasts when force_gcal_resync rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeStatus()
      if (cmd === 'force_gcal_resync') throw new Error('boom')
      return undefined
    })

    render(<GoogleCalendarSettingsTab />)
    const btn = await screen.findByTestId('gcal-resync-button')
    await user.click(btn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'GoogleCalendarSettingsTab',
        'failed to force resync',
        undefined,
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to start full resync')
  })
})

// ---------------------------------------------------------------------------
// Disconnect dialog — three choices
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — disconnect dialog', () => {
  async function openDisconnectDialog() {
    const user = userEvent.setup()
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)

    const btn = await screen.findByTestId('gcal-disconnect-button')
    await user.click(btn)
    const dialog = await screen.findByRole('alertdialog')
    return { user, dialog }
  }

  it('clicking "delete calendar" invokes disconnect_gcal({ deleteCalendar: true })', async () => {
    const { user, dialog } = await openDisconnectDialog()
    const deleteBtn = within(dialog).getByTestId('gcal-disconnect-delete')
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('disconnect_gcal', { deleteCalendar: true })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith(
      'Disconnected. Calendar deleted from Google.',
    )
  })

  it('clicking "keep calendar" invokes disconnect_gcal({ deleteCalendar: false })', async () => {
    const { user, dialog } = await openDisconnectDialog()
    const keepBtn = within(dialog).getByTestId('gcal-disconnect-keep')
    await user.click(keepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('disconnect_gcal', { deleteCalendar: false })
    })
    expect(mockedToastSuccess).toHaveBeenCalledWith(
      'Disconnected. Calendar kept in your Google account.',
    )
  })

  it('clicking Cancel closes the dialog and does not call disconnect_gcal', async () => {
    const { user, dialog } = await openDisconnectDialog()
    const cancelBtn = within(dialog).getByTestId('gcal-disconnect-cancel')
    await user.click(cancelBtn)

    // Dialog closes
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === 'disconnect_gcal'),
    ).toHaveLength(0)
  })

  it('logs + toasts when disconnect_gcal rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_gcal_status') return makeStatus()
      if (cmd === 'disconnect_gcal') throw new Error('disconnect boom')
      return undefined
    })

    render(<GoogleCalendarSettingsTab />)
    const btn = await screen.findByTestId('gcal-disconnect-button')
    await user.click(btn)
    const dialog = await screen.findByRole('alertdialog')
    const deleteBtn = within(dialog).getByTestId('gcal-disconnect-delete')
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(mockedLoggerError).toHaveBeenCalledWith(
        'GoogleCalendarSettingsTab',
        'failed to disconnect gcal',
        { deleteCalendar: true },
        expect.any(Error),
      )
    })
    expect(mockedToastError).toHaveBeenCalledWith('Failed to disconnect Google Calendar')
  })
})

// ---------------------------------------------------------------------------
// Status polling — 60 s interval
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — status polling', () => {
  it('re-fetches status every 60 s while mounted', async () => {
    vi.useFakeTimers()
    setupInvoke(makeStatus())

    render(<GoogleCalendarSettingsTab />)
    // Initial load
    await vi.waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_gcal_status')
    })
    const initialCount = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'get_gcal_status',
    ).length
    expect(initialCount).toBeGreaterThanOrEqual(1)

    // Advance 60 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    const afterCount = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'get_gcal_status',
    ).length
    expect(afterCount).toBeGreaterThan(initialCount)
  })
})

// ---------------------------------------------------------------------------
// Event stream — four Tauri events
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — event stream', () => {
  it('fires an error toast on gcal:reauth_required', async () => {
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)
    await screen.findByText('Google Calendar')
    // Wait for listeners to be registered (async).
    await waitFor(() => {
      expect(eventListeners.get('gcal:reauth_required')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:reauth_required')
    })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'Google sign-in expired. Reconnect to resume pushing.',
      )
    })
  })

  it('fires an info toast + re-fetch on gcal:push_disabled', async () => {
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)
    await screen.findByText('Google Calendar')
    await waitFor(() => {
      expect(eventListeners.get('gcal:push_disabled')).toBeDefined()
    })
    const callCountBefore = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'get_gcal_status',
    ).length

    act(() => {
      fireGcalEvent('gcal:push_disabled')
    })

    await waitFor(() => {
      expect(mockedToastInfo).toHaveBeenCalledWith('Google Calendar push has been disabled.')
    })
    const callCountAfter = mockedInvoke.mock.calls.filter(
      (c) => c[0] === 'get_gcal_status',
    ).length
    expect(callCountAfter).toBeGreaterThan(callCountBefore)
  })

  it('fires an error toast on gcal:keyring_unavailable', async () => {
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)
    await screen.findByText('Google Calendar')
    await waitFor(() => {
      expect(eventListeners.get('gcal:keyring_unavailable')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:keyring_unavailable')
    })

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'Cannot access the OS keychain. Google Calendar push is disabled on this device.',
      )
    })
  })

  it('fires an info toast on gcal:calendar_recreated', async () => {
    setupInvoke(makeStatus())
    render(<GoogleCalendarSettingsTab />)
    await screen.findByText('Google Calendar')
    await waitFor(() => {
      expect(eventListeners.get('gcal:calendar_recreated')).toBeDefined()
    })

    act(() => {
      fireGcalEvent('gcal:calendar_recreated')
    })

    await waitFor(() => {
      expect(mockedToastInfo).toHaveBeenCalledWith(
        'The Agaric Agenda calendar was recreated on your Google account.',
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Lease indicator variants
// ---------------------------------------------------------------------------

describe('GoogleCalendarSettingsTab — lease indicator', () => {
  it('shows "This device" when the lease is held locally', async () => {
    setupInvoke(
      makeStatus({
        push_lease: {
          held_by_this_device: true,
          device_id: 'this-device',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    )
    render(<GoogleCalendarSettingsTab />)
    expect(await screen.findByTestId('gcal-lease-this-device')).toHaveTextContent('This device')
  })

  it('shows "Other device" when the lease is held by another device', async () => {
    setupInvoke(
      makeStatus({
        push_lease: {
          held_by_this_device: false,
          device_id: 'other-device-id',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    )
    render(<GoogleCalendarSettingsTab />)
    const indicator = await screen.findByTestId('gcal-lease-other-device')
    expect(indicator).toHaveTextContent(/Other device/)
    expect(indicator).toHaveTextContent(/other-device-id/)
  })

  it('shows "No lease held" when disconnected', async () => {
    setupInvoke(makeDisconnectedStatus())
    render(<GoogleCalendarSettingsTab />)
    expect(await screen.findByTestId('gcal-lease-none')).toHaveTextContent('No lease held')
  })

  it('surfaces a last-error banner when status.last_error is non-null', async () => {
    setupInvoke(makeStatus({ last_error: 'quota exceeded, retry in 60s' }))
    render(<GoogleCalendarSettingsTab />)
    const errBanner = await screen.findByTestId('gcal-last-error')
    expect(errBanner).toHaveTextContent('quota exceeded, retry in 60s')
  })
})
