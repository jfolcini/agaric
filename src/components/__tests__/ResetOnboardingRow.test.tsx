/**
 * Tests for ResetOnboardingRow.
 *
 * Coverage:
 *  - Renders the title + description copy.
 *  - Click → clears the localStorage onboarding-seen flag.
 *  - Click → toast.success surfaces the confirmation copy.
 *  - axe(container) clean.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { ResetOnboardingRow } from '../settings/ResetOnboardingRow'

const ONBOARDING_KEY = t('space.onboardingSeenKey')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem(ONBOARDING_KEY)
})

describe('ResetOnboardingRow', () => {
  it('renders the title and description copy', () => {
    render(<ResetOnboardingRow />)

    expect(screen.getByText(t('settings.resetOnboarding.title'))).toBeInTheDocument()
    expect(screen.getByText(t('settings.resetOnboarding.description'))).toBeInTheDocument()
  })

  it('clears the onboarding-seen flag from localStorage on click', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ONBOARDING_KEY, 'true')

    render(<ResetOnboardingRow />)
    await user.click(screen.getByTestId('reset-onboarding-btn'))

    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull()
  })

  it('surfaces a success toast on click', async () => {
    const user = userEvent.setup()

    render(<ResetOnboardingRow />)
    await user.click(screen.getByTestId('reset-onboarding-btn'))

    expect(toast.success).toHaveBeenCalledWith(t('settings.resetOnboarding.success'))
  })

  it('has no a11y violations', async () => {
    const { container } = render(<ResetOnboardingRow />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
