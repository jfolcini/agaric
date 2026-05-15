/**
 * Tests for OAuthStatusSection — render + a11y per Phase 3b
 * (`pending/design-system-maintainability-2026-05-09.md`).
 *
 * The parent component test suite
 * (`src/components/__tests__/GoogleCalendarSettingsTab.test.tsx`) already
 * covers the click handlers + IPC dispatch end-to-end. These per-sibling
 * tests pin the contract — that this presentational component renders
 * the right test IDs / aria labels in each branch and produces no axe
 * violations — so future refactors of the orchestrator can't silently
 * regress the leaf.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { OAuthStatusSection } from '../OAuthStatusSection'

describe('OAuthStatusSection', () => {
  it('renders the Connect CTA when disconnected', () => {
    render(
      <OAuthStatusSection
        connected={false}
        accountEmail={null}
        oauthInFlight={false}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByTestId('gcal-connect-button')).toBeInTheDocument()
    expect(screen.queryByTestId('gcal-account-email')).not.toBeInTheDocument()
  })

  it('renders the email + Disconnect button when connected', () => {
    render(
      <OAuthStatusSection
        connected={true}
        accountEmail="me@example.org"
        oauthInFlight={false}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByTestId('gcal-account-email')).toHaveTextContent('me@example.org')
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument()
  })

  it('falls back to Connect CTA when connected but email is null', () => {
    // Defensive: GcalStatus.connected=true should imply non-null email,
    // but the section renders the CTA branch if the contract is violated
    // rather than crashing on a null code body.
    render(
      <OAuthStatusSection
        connected={true}
        accountEmail={null}
        oauthInFlight={false}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByTestId('gcal-connect-button')).toBeInTheDocument()
  })

  it('disables the Connect button + shows waiting label while oauthInFlight', () => {
    render(
      <OAuthStatusSection
        connected={false}
        accountEmail={null}
        oauthInFlight={true}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )

    const btn = screen.getByTestId('gcal-connect-button')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(btn).toHaveTextContent(/Waiting for Google/i)
  })

  it('has no axe violations in the disconnected state', async () => {
    const { container } = render(
      <OAuthStatusSection
        connected={false}
        accountEmail={null}
        oauthInFlight={false}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no axe violations in the connected state', async () => {
    const { container } = render(
      <OAuthStatusSection
        connected={true}
        accountEmail="me@example.org"
        oauthInFlight={false}
        onConnect={vi.fn()}
        onRequestDisconnect={vi.fn()}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
