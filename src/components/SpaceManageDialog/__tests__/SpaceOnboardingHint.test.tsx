/**
 * Tests for SpaceOnboardingHint (PEND-30 D-2 extraction).
 *
 * Coverage:
 *  - First render with open=true and ≤2 spaces shows the banner.
 *  - Dismiss persists `'true'` to localStorage under the stable key.
 *  - Subsequent mount with the flag set hides the banner.
 *  - Renders nothing when open=false.
 *  - Renders nothing when availableSpaceCount > 2.
 *  - resetOnboardingSeen() clears the localStorage flag.
 *  - readOnboardingSeen() reflects the localStorage state.
 *  - Stable token: ONBOARDING_STORAGE_KEY equals the historical
 *    i18n value `agaric:space-onboarding-seen-v1` so existing users
 *    are not re-shown the banner after upgrade.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'

import {
  ONBOARDING_STORAGE_KEY,
  readOnboardingSeen,
  resetOnboardingSeen,
  SpaceOnboardingHint,
} from '../SpaceOnboardingHint'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  localStorage.clear()
})

describe('SpaceOnboardingHint', () => {
  it('shows the banner on first render with open=true and ≤2 spaces', () => {
    render(<SpaceOnboardingHint open={true} availableSpaceCount={2} />)
    expect(screen.getByText(t('space.onboardingTitle'))).toBeInTheDocument()
    expect(screen.getByText(t('space.onboardingBody'))).toBeInTheDocument()
  })

  it('dismiss persists "true" to localStorage and unmounts the banner', async () => {
    const user = userEvent.setup()
    render(<SpaceOnboardingHint open={true} availableSpaceCount={2} />)

    await user.click(screen.getByRole('button', { name: t('space.onboardingDismiss') }))

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('true')
    await waitFor(() => {
      expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
    })
  })

  it('subsequent mount with the flag set hides the banner', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    render(<SpaceOnboardingHint open={true} availableSpaceCount={2} />)
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('renders nothing when open=false', () => {
    render(<SpaceOnboardingHint open={false} availableSpaceCount={2} />)
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('renders nothing when more than 2 spaces exist', () => {
    render(<SpaceOnboardingHint open={true} availableSpaceCount={3} />)
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('readOnboardingSeen reflects the localStorage state', () => {
    expect(readOnboardingSeen()).toBe(false)
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    expect(readOnboardingSeen()).toBe(true)
  })

  it('resetOnboardingSeen clears the localStorage flag', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    expect(readOnboardingSeen()).toBe(true)
    resetOnboardingSeen()
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull()
    expect(readOnboardingSeen()).toBe(false)
  })

  // Backwards-compat guard: pre-PEND-30 D-2 the storage key was
  // derived at runtime from `i18n.t('space.onboardingSeenKey')`. The
  // i18n value is `'agaric:space-onboarding-seen-v1'` (see
  // src/lib/i18n/common.ts). The new stable token MUST equal that
  // value verbatim so users who already dismissed the banner pre-D-2
  // do not see it again after upgrade.
  it('stable token equals the pre-D-2 i18n value (upgrade compat)', () => {
    expect(ONBOARDING_STORAGE_KEY).toBe('agaric:space-onboarding-seen-v1')
    expect(ONBOARDING_STORAGE_KEY).toBe(t('space.onboardingSeenKey'))
  })

  // SOURCE-LEVEL guard — the runtime-i18n indirection (`i18n.t(...)`)
  // for the storage key must not appear in the component module. The
  // key is now a module-level const.
  it('source no longer imports i18n; storage key is a module-level const', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'SpaceOnboardingHint.tsx'), 'utf8')
    // No import of the i18n module — the runtime-i18n key derivation
    // is gone for good.
    expect(src).not.toMatch(/from\s+['"]@\/lib\/i18n['"]/)
    // The const must be declared with the canonical historical value.
    expect(src).toContain("ONBOARDING_STORAGE_KEY = 'agaric:space-onboarding-seen-v1'")
  })
})
