/**
 * Tests for QuickCaptureFab (#920).
 *
 * The FAB is the mobile/touch entry point for quick-capture — the OS
 * global-shortcut chord is a no-op on phones, so without it the feature
 * is unreachable. Coverage:
 *  - Render gate: shows when `useShouldShowMobileChrome()` is true; renders
 *    nothing when false (desktop).
 *  - Click invokes the shared `setQuickCaptureOpen(true)` setter.
 *  - Steps aside while an editing toolbar is pinned and on a scroll down.
 *  - Carries the i18n aria-label + the stable test id.
 *  - axe clean.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { usePinToolbar } from '@/components/FormattingToolbar/pinned-toolbar'
import { QuickCaptureFab } from '@/components/mobile/QuickCaptureFab'
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

  it('sits 1rem above the bottom safe-area inset at 56 px, with no 44 px size variant', () => {
    // Every Button size sets a coarse-pointer 44 px that beats `size-14`. The
    // VARIABLE, not `env()` directly — same convention as `App.test.tsx`'s
    // main-content-viewport assertion.
    render(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    const fab = screen.getByTestId('quick-capture-fab')
    expect(fab.className).toContain('bottom-[calc(1rem+var(--safe-area-bottom))]')
    expect(fab.className).toContain('size-14')
    expect(fab.className).not.toContain('pointer:coarse')
    expect(fab.className).not.toContain('env(safe-area-inset-bottom)')
  })

  it('hides while an editing toolbar is pinned and returns when it unmounts', () => {
    function PinnedToolbar(): null {
      usePinToolbar(true)
      return null
    }
    const { rerender } = render(
      <>
        <QuickCaptureFab setQuickCaptureOpen={vi.fn()} />
        <PinnedToolbar />
      </>,
    )
    const fab = screen.getByTestId('quick-capture-fab')
    expect(fab).toHaveAttribute('data-shown', 'false')
    expect(fab.className).toContain('invisible')
    rerender(<QuickCaptureFab setQuickCaptureOpen={vi.fn()} />)
    expect(fab).toHaveAttribute('data-shown', 'true')
  })

  it('hides on a scroll down and returns on a scroll up', () => {
    render(
      <>
        <QuickCaptureFab setQuickCaptureOpen={vi.fn()} />
        <div id="main-content">
          <div data-testid="scroller" />
        </div>
      </>,
    )
    const fab = screen.getByTestId('quick-capture-fab')
    const scroller = screen.getByTestId('scroller')
    const scrollTo = (top: number) =>
      act(() => {
        scroller.scrollTop = top
        scroller.dispatchEvent(new Event('scroll'))
      })
    fireEvent.touchStart(scroller)
    scrollTo(200)
    expect(fab).toHaveAttribute('data-shown', 'false')
    // Jitter under the slop leaves it hidden.
    scrollTo(196)
    expect(fab).toHaveAttribute('data-shown', 'false')
    scrollTo(150)
    expect(fab).toHaveAttribute('data-shown', 'true')
    scrollTo(400)
    expect(fab).toHaveAttribute('data-shown', 'false')
    scrollTo(0)
    expect(fab).toHaveAttribute('data-shown', 'true')
  })

  it('a scroll restore after a remount is not a scroll down, but the next user scroll is', () => {
    render(
      <>
        <QuickCaptureFab setQuickCaptureOpen={vi.fn()} />
        <div id="main-content">
          <div data-testid="scroller" />
        </div>
      </>,
    )
    const fab = screen.getByTestId('quick-capture-fab')
    const scroller = screen.getByTestId('scroller')
    const scrollTo = (top: number) =>
      act(() => {
        scroller.scrollTop = top
        scroller.dispatchEvent(new Event('scroll'))
      })
    scrollTo(600)
    expect(fab).toHaveAttribute('data-shown', 'true')
    fireEvent.wheel(scroller)
    scrollTo(900)
    expect(fab).toHaveAttribute('data-shown', 'false')
  })

  it("stays shown when a popup's list scrolls down outside the view's content", () => {
    render(
      <>
        <QuickCaptureFab setQuickCaptureOpen={vi.fn()} />
        <div data-testid="popup-list" />
      </>,
    )
    const list = screen.getByTestId('popup-list')
    act(() => {
      list.scrollTop = 144
      list.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByTestId('quick-capture-fab')).toHaveAttribute('data-shown', 'true')
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
