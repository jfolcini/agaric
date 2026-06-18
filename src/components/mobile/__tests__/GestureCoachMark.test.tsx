/**
 * Tests for GestureCoachMark — first-run mobile gesture coach-mark (#1422).
 *
 * The overlay surfaces Agaric's hidden touch gestures once, on the first
 * mobile/touch launch, then never again. Coverage:
 *  - Render gate: shows on mobile (`useShouldShowMobileChrome()` true),
 *    renders nothing on desktop (false).
 *  - Lists the four key gestures (swipe / long-press / edge-swipe / FAB).
 *  - Dismissing sets the persisted "seen" flag.
 *  - One-time: with the flag set it does not re-render, and a remount
 *    after dismissal stays closed.
 *  - axe(container) a11y audit clean.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { GestureCoachMark } from '@/components/mobile/GestureCoachMark'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'
import { t } from '@/lib/i18n'

vi.mock('@/hooks/useShouldShowMobileChrome', () => ({
  useShouldShowMobileChrome: vi.fn(() => true),
}))

const mockedUseShouldShowMobileChrome = vi.mocked(useShouldShowMobileChrome)

// localStorage key persisted by `@/lib/gesture-coachmark`. Asserted by
// value so a renamed key is caught here rather than silently passing.
const SEEN_KEY = 'agaric-gesture-coachmark-seen'

const GESTURE_TITLE_KEYS = [
  'gestures.swipe.title',
  'gestures.longPress.title',
  'gestures.edgeSwipe.title',
  'gestures.quickCapture.title',
] as const

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseShouldShowMobileChrome.mockReturnValue(true)
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('GestureCoachMark', () => {
  it('renders the overlay on first mobile launch', () => {
    render(<GestureCoachMark />)
    expect(screen.getByTestId('gesture-coachmark')).toBeInTheDocument()
    expect(screen.getByText(t('gestures.coachmark.title'))).toBeInTheDocument()
  })

  it('renders nothing on desktop (mobile chrome off)', () => {
    mockedUseShouldShowMobileChrome.mockReturnValue(false)
    render(<GestureCoachMark />)
    expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
    expect(screen.queryByText(t('gestures.coachmark.title'))).toBeNull()
  })

  it('opens only when the mobile chrome turns on after a desktop-width boot', () => {
    // Boot desktop-width: gate off, nothing renders and (critically) the
    // open-state must NOT latch true at mount (#1749).
    mockedUseShouldShowMobileChrome.mockReturnValue(false)
    const { rerender } = render(<GestureCoachMark />)
    expect(screen.queryByTestId('gesture-coachmark')).toBeNull()

    // Narrow to mobile mid-session: the chrome turns on, so the coach-mark
    // surfaces once (genuine first mobile activation).
    mockedUseShouldShowMobileChrome.mockReturnValue(true)
    rerender(<GestureCoachMark />)
    expect(screen.getByTestId('gesture-coachmark')).toBeInTheDocument()
  })

  it('does not reopen on a later mobile flip once dismissed', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GestureCoachMark />)

    await user.click(screen.getByRole('button', { name: t('gestures.coachmark.dismiss') }))
    await waitFor(() => {
      expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
    })

    // Resize desktop then back to mobile: the seen flag keeps it closed.
    mockedUseShouldShowMobileChrome.mockReturnValue(false)
    rerender(<GestureCoachMark />)
    mockedUseShouldShowMobileChrome.mockReturnValue(true)
    rerender(<GestureCoachMark />)
    expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
  })

  it('lists the four key gestures', () => {
    render(<GestureCoachMark />)
    for (const key of GESTURE_TITLE_KEYS) {
      expect(screen.getByText(t(key))).toBeInTheDocument()
    }
  })

  it('dismissing sets the persisted seen flag and closes the overlay', async () => {
    const user = userEvent.setup()
    render(<GestureCoachMark />)

    expect(localStorage.getItem(SEEN_KEY)).toBeNull()

    await user.click(screen.getByRole('button', { name: t('gestures.coachmark.dismiss') }))

    await waitFor(() => {
      expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
    })
    expect(localStorage.getItem(SEEN_KEY)).toBe('true')
  })

  it('does not render when the seen flag is already set', () => {
    localStorage.setItem(SEEN_KEY, 'true')
    render(<GestureCoachMark />)
    expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
  })

  it('stays dismissed across a remount once seen', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<GestureCoachMark />)

    await user.click(screen.getByRole('button', { name: t('gestures.coachmark.dismiss') }))
    await waitFor(() => {
      expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
    })

    unmount()
    render(<GestureCoachMark />)
    expect(screen.queryByTestId('gesture-coachmark')).toBeNull()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GestureCoachMark />)
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
