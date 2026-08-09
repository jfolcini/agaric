/**
 * Tests for ShowWelcomeTourRow + the onboarding re-entry path (#3308).
 *
 * Before this row existed, dismissing the first-run `WelcomeModal` by ANY
 * close path (Get Started, click-outside, Escape / Android Back) set
 * `agaric-onboarding-done` forever — nothing in the product could bring the
 * tour, or its "Create sample pages" action, back. These tests pin:
 *  - the row renders and its button resets the WELCOME flag,
 *  - `resetOnboarding()` clears the flag (and not the unrelated
 *    spaces-onboarding flag the neighbouring ResetOnboardingRow owns),
 *  - and, end to end, that clicking it actually RE-OPENS the modal in the
 *    live App-shell gate (`useWelcomeGate`) — the modal derives `open` from
 *    a mount-time read of the flag, so re-showing has to remount it.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { WelcomeModal } from '@/components/pages/WelcomeModal'
import { ShowWelcomeTourRow } from '@/components/settings/ShowWelcomeTourRow'
import { useWelcomeGate } from '@/hooks/useWelcomeGate'
import { isOnboardingDone, markOnboardingDone, resetOnboarding } from '@/lib/onboarding'
import { useBootStore } from '@/stores/boot'
import { useSpaceStore } from '@/stores/space'

/** No-op boot function to prevent side-effects. */
const noopBoot = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useBootStore.setState({ state: 'ready', error: null, boot: noopBoot })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

/**
 * Miniature stand-in for the App shell's welcome wiring: the same
 * `useWelcomeGate()` gate + `key`-driven remount that `App.tsx` uses, next
 * to the Settings row that resets it.
 */
function WelcomeGateHarness(): React.ReactElement {
  const { show, remountKey } = useWelcomeGate()
  return (
    <div>
      <ShowWelcomeTourRow />
      {show && <WelcomeModal key={remountKey} />}
    </div>
  )
}

describe('resetOnboarding', () => {
  it('clears the onboarding-done flag so the welcome modal shows again', () => {
    markOnboardingDone()
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')
    expect(isOnboardingDone()).toBe(true)

    resetOnboarding()

    expect(localStorage.getItem('agaric-onboarding-done')).toBeNull()
    expect(isOnboardingDone()).toBe(false)
  })

  it('leaves the unrelated spaces-onboarding flag alone', () => {
    markOnboardingDone()
    localStorage.setItem('agaric:space-onboarding-seen-v1', 'true')

    resetOnboarding()

    expect(localStorage.getItem('agaric:space-onboarding-seen-v1')).toBe('true')
  })
})

describe('ShowWelcomeTourRow', () => {
  it('renders the row copy and button', () => {
    render(<ShowWelcomeTourRow />)

    expect(screen.getByText('Show the welcome tour again')).toBeInTheDocument()
    expect(screen.getByTestId('show-welcome-tour-btn')).toBeInTheDocument()
  })

  it('clicking it clears the onboarding flag and confirms with a toast', async () => {
    const user = userEvent.setup()
    markOnboardingDone()

    render(<ShowWelcomeTourRow />)
    await user.click(screen.getByTestId('show-welcome-tour-btn'))

    expect(localStorage.getItem('agaric-onboarding-done')).toBeNull()
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Welcome tour reopened')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ShowWelcomeTourRow />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('welcome tour re-entry (#3308)', () => {
  it('re-opens the welcome modal after the tour was already completed', async () => {
    const user = userEvent.setup()
    markOnboardingDone()

    render(<WelcomeGateHarness />)

    // The gate keeps the modal (and its chunk) out of the tree entirely.
    expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('show-welcome-tour-btn'))

    await waitFor(() => {
      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    })
  })

  it('re-opens the welcome modal after it was dismissed in the SAME session', async () => {
    const user = userEvent.setup()

    render(<WelcomeGateHarness />)

    // First run: the modal is up; dismiss it permanently.
    expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Get Started' }))
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    })
    expect(localStorage.getItem('agaric-onboarding-done')).toBe('true')

    // The component is still mounted with `open === false`, so the reset
    // has to REMOUNT it — this is the case a naive `setShow(true)` misses.
    await user.click(screen.getByTestId('show-welcome-tour-btn'))

    await waitFor(() => {
      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    })
  })

  it('re-opens the welcome modal after an Escape / close-all-overlays dismissal', async () => {
    const user = userEvent.setup()

    render(<WelcomeGateHarness />)

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Agaric')).not.toBeInTheDocument()
    })

    await user.click(screen.getByTestId('show-welcome-tour-btn'))

    await waitFor(() => {
      expect(screen.getByText('Welcome to Agaric')).toBeInTheDocument()
    })
  })
})
