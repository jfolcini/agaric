/**
 * Tests for QuickCaptureFab (#920).
 *
 * The FAB is the mobile/touch entry point for quick-capture — the OS
 * global-shortcut chord is a no-op on phones, so without it the feature
 * is unreachable. Coverage:
 *  - Render gate: shows when `useShouldShowMobileChrome()` is true; renders
 *    nothing when false (desktop).
 *  - Click invokes the shared `setQuickCaptureOpen(true)` setter.
 *  - Carries the i18n aria-label + the stable test id.
 *  - axe clean.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { QuickCaptureFab } from '@/components/layout/QuickCaptureFab'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'

vi.mock('@/hooks/useShouldShowMobileChrome', () => ({
  useShouldShowMobileChrome: vi.fn(() => true),
}))

const mockedUseShouldShowMobileChrome = vi.mocked(useShouldShowMobileChrome)

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseShouldShowMobileChrome.mockReturnValue(true)
})

describe('QuickCaptureFab', () => {
  it('renders the FAB when mobile chrome is on', () => {
    render(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    expect(screen.getByTestId('quick-capture-fab')).toBeInTheDocument()
  })

  it('renders nothing when mobile chrome is off (desktop)', () => {
    mockedUseShouldShowMobileChrome.mockReturnValue(false)
    render(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    expect(screen.queryByTestId('quick-capture-fab')).toBeNull()
  })

  it('is an accessible, labelled button', () => {
    render(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    // The aria-label comes from i18n; assert the resolved English string so
    // a missing/renamed key is caught here rather than silently passing.
    const fab = screen.getByRole('button', { name: 'Quick capture' })
    expect(fab).toBe(screen.getByTestId('quick-capture-fab'))
  })

  it('calls setQuickCaptureOpen(true) on click', async () => {
    const user = userEvent.setup()
    const setQuickCaptureOpen = vi.fn()
    render(<QuickCaptureFab setQuickCaptureOpen={setQuickCaptureOpen} />)

    await user.click(screen.getByTestId('quick-capture-fab'))

    expect(setQuickCaptureOpen).toHaveBeenCalledTimes(1)
    expect(setQuickCaptureOpen).toHaveBeenCalledWith(true)
  })

  it('does not call the setter when mobile chrome is off', async () => {
    mockedUseShouldShowMobileChrome.mockReturnValue(false)
    const setQuickCaptureOpen = vi.fn()
    render(<QuickCaptureFab setQuickCaptureOpen={setQuickCaptureOpen} />)

    expect(screen.queryByTestId('quick-capture-fab')).toBeNull()
    expect(setQuickCaptureOpen).not.toHaveBeenCalled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
