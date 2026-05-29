/**
 * Tests for SyncStatusSection — render + a11y per Phase 3b
 * (`pending/design-system-maintainability-2026-05-09.md`). Pins the
 * presentational contract for the status panel (last push, lease,
 * error banner) so future orchestrator refactors can't silently
 * regress the test IDs the parent suite depends on.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import type { GcalStatus } from '@/lib/bindings'

import { SyncStatusSection } from '../SyncStatusSection'

function makeStatus(overrides: Partial<GcalStatus> = {}): GcalStatus {
  return {
    connected: true,
    account_email: 'user@example.com',
    calendar_id: 'agaric-agenda-cal-id',
    window_days: 30,
    privacy_mode: 'full',
    last_push_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    last_error: null,
    push_lease: {
      held_by_this_device: true,
      device_id: 'this-device',
      expires_at: new Date(Date.now() + 180_000).toISOString(),
    },
    ...overrides,
  }
}

describe('SyncStatusSection', () => {
  it('renders the status panel container', () => {
    render(<SyncStatusSection status={makeStatus()} />)
    expect(screen.getByTestId('gcal-status-panel')).toBeInTheDocument()
  })

  it('renders "This device" when the lease is held locally', () => {
    render(<SyncStatusSection status={makeStatus()} />)
    expect(screen.getByTestId('gcal-lease-this-device')).toHaveTextContent('This device')
  })

  it('renders "Other device" when the lease is held by another device', () => {
    render(
      <SyncStatusSection
        status={makeStatus({
          push_lease: {
            held_by_this_device: false,
            device_id: 'other-device-id',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        })}
      />,
    )
    const indicator = screen.getByTestId('gcal-lease-other-device')
    expect(indicator).toHaveTextContent(/Other device/)
    expect(indicator).toHaveTextContent(/other-device-id/)
  })

  it('renders "No lease held" when disconnected', () => {
    render(
      <SyncStatusSection
        status={makeStatus({
          connected: false,
          push_lease: { held_by_this_device: false, device_id: null, expires_at: null },
        })}
      />,
    )
    expect(screen.getByTestId('gcal-lease-none')).toHaveTextContent('No lease held')
  })

  it('surfaces a last-error banner when status.last_error is non-null', () => {
    render(
      <SyncStatusSection status={makeStatus({ last_error: 'quota exceeded, retry in 60s' })} />,
    )
    expect(screen.getByTestId('gcal-last-error')).toHaveTextContent('quota exceeded, retry in 60s')
  })

  it('renders the "Never" placeholder when last_push_at is null', () => {
    render(<SyncStatusSection status={makeStatus({ last_push_at: null })} />)
    const lastPush = screen.getByTestId('gcal-last-push')
    expect(lastPush).toBeInTheDocument()
    expect(lastPush.textContent).toMatch(/Never/i)
  })

  it('has no axe violations', async () => {
    const { container } = render(<SyncStatusSection status={makeStatus()} />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
