/**
 * Tests for QuickCaptureRow — the desktop-only quick-capture chord setting.
 *
 * The row configures a global shortcut that is wired to
 * `registerGlobalShortcut`, which no-ops on mobile PLATFORMS (the
 * `isMobilePlatform()` UA capability check). The regression these tests
 * lock in (#742): the row's visibility must follow that SAME capability
 * check, not the viewport-width breakpoint (`useIsMobile`). Otherwise an
 * Android tablet ≥ 768 px would render the row and silently accept a
 * chord that never registers.
 *
 * Validates:
 *  - DESKTOP wide → row renders.
 *  - DESKTOP narrow width (< 768 px) → row STILL renders. Width is a
 *    layout signal; it must NOT capability-gate this setting.
 *  - MOBILE platform at a wide (≥ 768 px tablet) width → row is HIDDEN.
 *    Capability, not width, drives visibility.
 *  - axe(container) audit clean.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'
import { notify } from '@/lib/notify'
import { registerGlobalShortcut } from '@/lib/tauri'

import { QuickCaptureRow } from '../settings/QuickCaptureRow'

// The row imports `registerGlobalShortcut`/`unregisterGlobalShortcut`
// from `@/lib/tauri`; stub them so nothing reaches the real Tauri plugin.
vi.mock('@/lib/tauri', () => ({
  registerGlobalShortcut: vi.fn(async () => undefined),
  unregisterGlobalShortcut: vi.fn(async () => undefined),
}))

// The save path surfaces failures via `notify.error`; mock it so the
// error-path test can assert it fires.
vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
// An Android *tablet* — note the width set alongside it is ≥ 768 px, the
// exact case the old width gate (`useIsMobile`) got wrong.
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

let originalUA: string
let originalInnerWidth: number

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  })
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
}

beforeEach(() => {
  originalUA = navigator.userAgent
  originalInnerWidth = window.innerWidth
  setUserAgent(DESKTOP_UA)
  setInnerWidth(1280)
  localStorage.clear()
})

afterEach(() => {
  setUserAgent(originalUA)
  setInnerWidth(originalInnerWidth)
  vi.clearAllMocks()
})

describe('QuickCaptureRow — capability gate (#742)', () => {
  it('renders on a desktop platform at a wide width', () => {
    render(<QuickCaptureRow />)
    expect(screen.getByTestId('quick-capture-settings-row')).toBeInTheDocument()
    expect(screen.getByText(t('settings.quickCapture.label'))).toBeInTheDocument()
  })

  it('STILL renders on a desktop platform at a NARROW width (width is layout, not a capability gate)', () => {
    // A narrow desktop window (e.g. resized side-by-side) is < 768 px, the
    // threshold the old `useIsMobile` gate keyed on. The capability check
    // ignores width, so the desktop-only chord setting must remain visible.
    setInnerWidth(500)
    render(<QuickCaptureRow />)
    expect(screen.getByTestId('quick-capture-settings-row')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('settings.quickCapture.editButton') }),
    ).toBeInTheDocument()
  })

  it('is HIDDEN on a mobile platform even at a wide (>= 768 px tablet) width', () => {
    // The bug: width >= 768 used to render the row, but the chord can never
    // register on Android. Gating on `isMobilePlatform()` hides it.
    setUserAgent(ANDROID_TABLET_UA)
    setInnerWidth(1100) // landscape tablet — comfortably >= 768 px
    const { container } = render(<QuickCaptureRow />)
    expect(screen.queryByTestId('quick-capture-settings-row')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('has no a11y violations when rendered', async () => {
    const { container } = render(<QuickCaptureRow />)
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('surfaces notify.error when the chord fails to register (IPC error path)', async () => {
    // Probing the new chord can reject (e.g. the chord is already claimed
    // by another app); the save handler catches and surfaces saveFailed.
    vi.mocked(registerGlobalShortcut).mockRejectedValueOnce(new Error('chord already in use'))
    render(<QuickCaptureRow />)

    fireEvent.click(screen.getByTestId('quick-capture-shortcut-edit'))
    fireEvent.change(screen.getByTestId('quick-capture-shortcut-input'), {
      target: { value: 'Alt+Shift+K' },
    })
    fireEvent.click(screen.getByTestId('quick-capture-shortcut-save'))

    await waitFor(() => {
      expect(vi.mocked(notify.error)).toHaveBeenCalledWith(t('settings.quickCapture.saveFailed'))
    })
  })
})
