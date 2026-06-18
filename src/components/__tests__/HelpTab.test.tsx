/**
 * Tests for HelpTab — Help / Updates panel.
 *
 * Validates:
 *  - Report-a-bug button renders + fires onReportBugClick
 *  - Updates card renders on desktop with the "Check for updates now" button
 *  - Updates card shows the mobile hint instead of the button on mobile
 *  - axe(container) audit clean on both UAs
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { HelpTab } from '../settings/HelpTab'

// Stub the updater hook surface — the manual button shouldn't actually
// reach into the Tauri updater plugin from inside a unit test.
vi.mock('@/hooks/useUpdateCheck', () => ({
  LAST_UPDATE_CHECK_STORAGE_KEY: 'agaric:last-update-check',
  checkForUpdatesNow: vi.fn(async () => undefined),
}))

const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

let originalUA: string

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  })
}

beforeEach(() => {
  originalUA = navigator.userAgent
  setUserAgent(DESKTOP_UA)
  localStorage.clear()
})

afterEach(() => {
  setUserAgent(originalUA)
})

describe('HelpTab', () => {
  it('renders the Report-a-bug button and fires onReportBugClick when clicked', async () => {
    const user = userEvent.setup()
    const onReportBugClick = vi.fn()
    render(<HelpTab onReportBugClick={onReportBugClick} />)

    const btn = screen.getByRole('button', { name: t('help.reportBugButton') })
    await user.click(btn)

    expect(onReportBugClick).toHaveBeenCalledOnce()
  })

  it('renders the Updates card with the Check-now button on desktop', () => {
    render(<HelpTab onReportBugClick={vi.fn()} />)

    expect(screen.getByText(t('help.updateTitle'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('help.updateCheckNowButton') })).toBeInTheDocument()
    // Last-checked label defaults to "Never checked" when LS is empty.
    expect(screen.getByText(t('help.updateLastCheckedNever'))).toBeInTheDocument()
  })

  it('replaces the button with the mobile hint on mobile UA', () => {
    setUserAgent(ANDROID_UA)
    render(<HelpTab onReportBugClick={vi.fn()} />)

    expect(screen.getByText(t('help.updateMobileHint'))).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('help.updateCheckNowButton') }),
    ).not.toBeInTheDocument()
  })

  it('clicking Check now invokes checkForUpdatesNow', async () => {
    const user = userEvent.setup()
    const { checkForUpdatesNow } = await import('@/hooks/useUpdateCheck')
    vi.mocked(checkForUpdatesNow).mockClear()

    render(<HelpTab onReportBugClick={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: t('help.updateCheckNowButton') }))

    expect(checkForUpdatesNow).toHaveBeenCalledOnce()
  })

  it('has no a11y violations on desktop', async () => {
    const { container } = render(<HelpTab onReportBugClick={vi.fn()} />)
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations on mobile', async () => {
    setUserAgent(ANDROID_UA)
    const { container } = render(<HelpTab onReportBugClick={vi.fn()} />)
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  // #1422 — persistent "Touch gestures" reference card. Lists the same
  // hidden gestures the first-run coach-mark surfaces, so users can
  // re-find them after the one-time overlay is dismissed.
  describe('Touch gestures section', () => {
    it('renders the Touch gestures card and all four gesture rows', () => {
      render(<HelpTab onReportBugClick={vi.fn()} />)

      expect(screen.getByText(t('gestures.help.title'))).toBeInTheDocument()
      expect(screen.getByText(t('gestures.swipe.title'))).toBeInTheDocument()
      expect(screen.getByText(t('gestures.longPress.title'))).toBeInTheDocument()
      expect(screen.getByText(t('gestures.edgeSwipe.title'))).toBeInTheDocument()
      expect(screen.getByText(t('gestures.quickCapture.title'))).toBeInTheDocument()
    })

    it('lists the gestures on mobile too', () => {
      setUserAgent(ANDROID_UA)
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByText(t('gestures.help.title'))).toBeInTheDocument()
      expect(screen.getByText(t('gestures.swipe.title'))).toBeInTheDocument()
    })
  })
})
