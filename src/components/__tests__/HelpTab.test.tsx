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

import { HelpTab } from '@/components/settings/HelpTab'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { t } from '@/lib/i18n'
import type { UpdateStatusValue } from '@/lib/preferences'

// Stub the updater hook surface — the manual button shouldn't actually
// reach into the Tauri updater plugin from inside a unit test, and the
// persisted status is fed in directly via `useUpdateStatus` so each card
// state can be rendered deterministically.
const { mockCheckForUpdatesNow, mockUseUpdateStatus } = vi.hoisted(() => ({
  mockCheckForUpdatesNow: vi.fn(async () => undefined),
  mockUseUpdateStatus: vi.fn<() => UpdateStatusValue>(),
}))

vi.mock('@/hooks/useUpdateCheck', () => ({
  checkForUpdatesNow: mockCheckForUpdatesNow,
  useUpdateStatus: () => mockUseUpdateStatus(),
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
  mockCheckForUpdatesNow.mockClear()
  mockUseUpdateStatus.mockReset()
  mockUseUpdateStatus.mockReturnValue({ status: 'idle' })
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

  // #3076 — the Updates card renders the persisted status for every state so
  // the control is never a bare, stateless button.
  describe('persistent update status (#3076)', () => {
    it('renders "Up to date (v…)" with a relative last-checked time', () => {
      const iso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      mockUseUpdateStatus.mockReturnValue({
        status: 'up-to-date',
        currentVersion: '0.9.1',
        lastCheckedAt: iso,
      })
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByRole('status')).toHaveTextContent(
        t('help.updateUpToDateLabel', { version: '0.9.1' }),
      )
      expect(
        screen.getByText(t('help.updateLastCheckedLabel', { ago: formatRelativeTime(iso, t) })),
      ).toBeInTheDocument()
    })

    it('renders a version-less "Up to date" when the running version is unknown', () => {
      mockUseUpdateStatus.mockReturnValue({ status: 'up-to-date' })
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByRole('status')).toHaveTextContent(t('help.updateUpToDateLabelNoVersion'))
    })

    it('renders "Update available: v…" when a newer release exists', () => {
      mockUseUpdateStatus.mockReturnValue({
        status: 'available',
        availableVersion: '2.0.0',
        currentVersion: '0.9.1',
      })
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByRole('status')).toHaveTextContent(
        t('help.updateAvailableStatus', { version: '2.0.0' }),
      )
    })

    it('renders the captured error message (not swallowed) on a failed check', () => {
      mockUseUpdateStatus.mockReturnValue({ status: 'error', error: 'network down' })
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByRole('status')).toHaveTextContent(
        t('help.updateCheckFailedLabel', { error: 'network down' }),
      )
    })

    it('disables the button and shows "Checking…" while a check is in flight', () => {
      mockUseUpdateStatus.mockReturnValue({ status: 'checking' })
      render(<HelpTab onReportBugClick={vi.fn()} />)
      expect(screen.getByRole('button', { name: t('help.updateCheckNowButton') })).toBeDisabled()
      expect(screen.getByRole('status')).toHaveTextContent(t('help.updateCheckingLabel'))
    })

    it('has no a11y violations in the error state', async () => {
      mockUseUpdateStatus.mockReturnValue({
        status: 'error',
        error: 'network down',
        lastCheckedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      })
      const { container } = render(<HelpTab onReportBugClick={vi.fn()} />)
      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
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
