/**
 * Tests for RecentPagesStrip (FEAT-9).
 *
 * Verifies:
 *  - Renders all retained recent pages as chips when no active page filter.
 *  - Excludes the currently-open page from the strip.
 *  - Auto-hides when the visible list is empty.
 *  - Auto-hides on mobile.
 *  - Plain click → navigateToPage.
 *  - Ctrl/Cmd/middle-click → openInNewTab.
 *  - Chip carries a title tooltip for truncation context.
 *  - axe clean.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useNavigationStore } from '../../stores/navigation'
import { useRecentPagesStore } from '../../stores/recent-pages'
import { useTabsStore } from '../../stores/tabs'
import { RecentPagesStrip } from '../RecentPagesStrip'

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedUseIsMobile = vi.mocked(useIsMobile)

function seedTab(pageId: string, title: string) {
  useNavigationStore.setState({
    currentView: 'page-editor',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId, title }], label: title }],
    activeTabIndex: 0,
  })
}

function clearActiveTab() {
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(false)
  useRecentPagesStore.setState({ recentPages: [] })
  clearActiveTab()
  localStorage.clear()
})

describe('RecentPagesStrip', () => {
  it('renders all retained pages as chips', () => {
    const { recordVisit } = useRecentPagesStore.getState()
    recordVisit({ pageId: 'A', title: 'Alpha' })
    recordVisit({ pageId: 'B', title: 'Bravo' })
    recordVisit({ pageId: 'C', title: 'Charlie' })
    recordVisit({ pageId: 'D', title: 'Delta' })

    render(<RecentPagesStrip />)

    const strip = screen.getByTestId('recent-pages-strip')
    const chips = within(strip).getAllByRole('button')
    expect(chips).toHaveLength(4)
  })

  it('excludes the currently-open page', () => {
    const { recordVisit } = useRecentPagesStore.getState()
    recordVisit({ pageId: 'A', title: 'Alpha' })
    recordVisit({ pageId: 'B', title: 'Bravo' })
    recordVisit({ pageId: 'C', title: 'Charlie' })

    seedTab('B', 'Bravo')

    render(<RecentPagesStrip />)

    const strip = screen.getByTestId('recent-pages-strip')
    const chips = within(strip).getAllByRole('button')
    expect(chips).toHaveLength(2)

    const labels = chips.map((c) => c.textContent)
    expect(labels).toContain('Alpha')
    expect(labels).toContain('Charlie')
    expect(labels).not.toContain('Bravo')
  })

  it('auto-hides when empty', () => {
    render(<RecentPagesStrip />)
    expect(screen.queryByTestId('recent-pages-strip')).toBeNull()
  })

  it('auto-hides when the only recent page is the currently-open one', () => {
    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })
    seedTab('A', 'Alpha')

    render(<RecentPagesStrip />)

    expect(screen.queryByTestId('recent-pages-strip')).toBeNull()
  })

  it('hides the strip on mobile', () => {
    mockedUseIsMobile.mockReturnValue(true)

    const { recordVisit } = useRecentPagesStore.getState()
    recordVisit({ pageId: 'A', title: 'Alpha' })
    recordVisit({ pageId: 'B', title: 'Bravo' })

    render(<RecentPagesStrip />)

    expect(screen.queryByTestId('recent-pages-strip')).toBeNull()
  })

  it('click navigates to the page', async () => {
    const user = userEvent.setup()
    const navigateSpy = vi.fn()
    useTabsStore.setState({ navigateToPage: navigateSpy })

    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Alpha' })
    await user.click(chip)

    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).toHaveBeenCalledWith('A', 'Alpha')
  })

  it('ctrl+click opens in a new tab', () => {
    const navigateSpy = vi.fn()
    const openInNewTabSpy = vi.fn()
    useTabsStore.setState({
      navigateToPage: navigateSpy,
      openInNewTab: openInNewTabSpy,
    })

    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Alpha' })
    fireEvent.click(chip, { ctrlKey: true })

    expect(openInNewTabSpy).toHaveBeenCalledTimes(1)
    expect(openInNewTabSpy).toHaveBeenCalledWith('A', 'Alpha')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('cmd+click opens in a new tab (macOS)', () => {
    const navigateSpy = vi.fn()
    const openInNewTabSpy = vi.fn()
    useTabsStore.setState({
      navigateToPage: navigateSpy,
      openInNewTab: openInNewTabSpy,
    })

    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Alpha' })
    fireEvent.click(chip, { metaKey: true })

    expect(openInNewTabSpy).toHaveBeenCalledTimes(1)
    expect(openInNewTabSpy).toHaveBeenCalledWith('A', 'Alpha')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('middle-click opens in a new tab', () => {
    const navigateSpy = vi.fn()
    const openInNewTabSpy = vi.fn()
    useTabsStore.setState({
      navigateToPage: navigateSpy,
      openInNewTab: openInNewTabSpy,
    })

    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Alpha' })
    // `auxclick` isn't in fireEvent's shorthand map; dispatch a real
    // MouseEvent so React's synthetic `onAuxClick` handler fires.
    fireEvent(chip, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))

    expect(openInNewTabSpy).toHaveBeenCalledTimes(1)
    expect(openInNewTabSpy).toHaveBeenCalledWith('A', 'Alpha')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('renders a title attribute for hover tooltip on long titles', () => {
    const longTitle = 'A very long page title that will likely truncate in the chip'
    useRecentPagesStore.getState().recordVisit({ pageId: 'LONG', title: longTitle })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: longTitle })
    expect(chip).toHaveAttribute('title', longTitle)
  })

  it('falls back to "Untitled" when the title is empty', () => {
    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: '' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Untitled' })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute('title', 'Untitled')
  })

  it('has no a11y violations when populated', async () => {
    const { recordVisit } = useRecentPagesStore.getState()
    recordVisit({ pageId: 'A', title: 'Alpha' })
    recordVisit({ pageId: 'B', title: 'Bravo' })

    const { container } = render(<RecentPagesStrip />)

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  // UX-284: keyboard focus on a chip should be visible from more than
  // just the focus ring — a subtle background tint is also applied via
  // `focus-visible:bg-accent/60` (PEND-19 bumped the prior `/50` to `/60`
  // when the chip moved off the `Button ghost` baseline; the chip now has
  // its own visible rest-state, so the focus tint is one shade darker to
  // stay distinguishable from hover). The class is present unconditionally
  // in markup; Tailwind activates it via the `focus-visible:` variant.
  // Asserting the className substring pins the discoverability fix without
  // coupling to jsdom's :focus-visible matching (which is unreliable).
  it('chips carry the focus-tint class for keyboard discoverability (UX-284)', () => {
    useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

    render(<RecentPagesStrip />)

    const chip = screen.getByRole('button', { name: 'Alpha' })
    expect(chip.className).toContain('focus-visible:bg-accent/60')
  })

  // ---------------------------------------------------------------------------
  // PEND-19: chip styling — visible rest-state chrome, tighter geometry
  // ---------------------------------------------------------------------------
  describe('chip styling (PEND-19)', () => {
    it('chips render with visible rest-state chrome (border + bg-secondary tint)', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<RecentPagesStrip />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      // PEND-19's chipClass spec — the rest-state chrome the redesign
      // introduces. Asserting class substrings (rather than computed style)
      // is the simplest way to pin the rest-state without coupling to
      // jsdom's CSS engine.
      expect(chip.className).toContain('border')
      expect(chip.className).toContain('border-border/60')
      expect(chip.className).toContain('bg-secondary/40')
      expect(chip.className).toContain('text-muted-foreground')
    })

    it('chips truncate at the chosen max-width (160 px)', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<RecentPagesStrip />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      // PEND-19 sized the chip to its content with a hard upper bound so
      // long titles don't blow out the row width.
      expect(chip.className).toContain('max-w-[160px]')
    })

    it('chips set shrink-0 so the flex container does not compress them', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<RecentPagesStrip />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      // PEND-32 relies on this — without `shrink-0`, the flex children
      // would compress to fit the viewport instead of overflowing into
      // the horizontal scroll.
      expect(chip.className).toContain('shrink-0')
    })

    it('chips render as a custom `<button>` (not a Button ghost variant)', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<RecentPagesStrip />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      // The new chip uses the `recent-page-chip` data-slot; the prior
      // `Button` baseline emitted `data-slot="button"` and a `ghost`
      // `data-variant`. Asserting on the new slot pins the redesign.
      expect(chip.getAttribute('data-slot')).toBe('recent-page-chip')
      expect(chip.getAttribute('data-variant')).toBeNull()
    })

    it('chips scale to 44 px touch target on coarse pointers (AGENTS.md mandatory pattern)', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<RecentPagesStrip />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      // Resting `h-7` (28 px) is below the 44 px floor AGENTS.md requires
      // for any interactive element on a touch pointer. The strip is also
      // mobile-hidden via `useIsMobile()`, but hybrid pointer devices
      // (touch laptops, tablets in desktop mode) pass that gate while
      // still reporting `pointer: coarse`. The chip carries explicit
      // touch-target scaling so it stays compliant on those devices.
      expect(chip.className).toContain('[@media(pointer:coarse)]:h-11')
      expect(chip.className).toContain('[@media(pointer:coarse)]:px-3')
    })
  })

  // ---------------------------------------------------------------------------
  // PEND-32: single-line horizontal scroll layout
  // ---------------------------------------------------------------------------
  describe('single-line horizontal scroll (PEND-32)', () => {
    function seedFiveChips() {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })
      recordVisit({ pageId: 'D', title: 'Delta' })
      recordVisit({ pageId: 'E', title: 'Echo' })
    }

    it('renders the chip row inside a horizontal ScrollArea (no grid, no flex-wrap)', () => {
      seedFiveChips()
      const { container } = render(<RecentPagesStrip />)

      // ScrollArea Root carries `data-slot="scroll-area"` from `ui/scroll-area.tsx`.
      const scrollArea = container.querySelector('[data-slot="scroll-area"]')
      expect(scrollArea).not.toBeNull()

      // The viewport hosts the wheel handler and the `flex` chip row.
      const viewport = container.querySelector(
        '[data-slot="scroll-area-viewport"]',
      ) as HTMLElement | null
      expect(viewport).not.toBeNull()

      // Inner chip row is a single-line flex container — no `grid`, no
      // `flex-wrap`. PEND-32 explicitly walked back PEND-19's flex-wrap.
      const innerRow = viewport?.querySelector('div.flex')
      expect(innerRow).not.toBeNull()
      expect(innerRow?.className).toContain('flex')
      expect(innerRow?.className).not.toContain('flex-wrap')
      expect(innerRow?.className).not.toContain('grid')
      // Horizontal scroller renders one ScrollArea, never two — guard
      // against a regression that wraps the row in `<ScrollArea
      // orientation="both">`.
      expect(container.querySelectorAll('[data-slot="scroll-area"]')).toHaveLength(1)
    })

    it('moves the row padding from the outer <nav> to the inner flex container', () => {
      seedFiveChips()
      const { container } = render(<RecentPagesStrip />)

      const strip = screen.getByTestId('recent-pages-strip')
      // Outer nav keeps the border + bg only; the previous `px-4 md:px-6
      // py-1.5` lived here and confused the ScrollArea scrollbar inset.
      expect(strip.className).not.toContain('px-4')
      expect(strip.className).not.toContain('py-1.5')

      const innerRow = container.querySelector(
        '[data-slot="scroll-area-viewport"] div.flex',
      ) as HTMLElement | null
      // Tightened padding — `py-1` (4 px) instead of the old `py-1.5`
      // (6 px) — and the horizontal padding moved inside.
      expect(innerRow?.className).toContain('px-4')
      expect(innerRow?.className).toContain('md:px-6')
      expect(innerRow?.className).toContain('py-1')
      expect(innerRow?.className).not.toContain('py-1.5')
    })

    it('translates dominant vertical wheel deltas to horizontal scroll', () => {
      seedFiveChips()
      const { container } = render(<RecentPagesStrip />)

      const viewport = container.querySelector(
        '[data-slot="scroll-area-viewport"]',
      ) as HTMLDivElement
      expect(viewport).not.toBeNull()

      viewport.scrollLeft = 0
      const evt = new WheelEvent('wheel', {
        deltaY: 120,
        deltaX: 0,
        bubbles: true,
        cancelable: true,
      })
      // Spy on preventDefault on the event itself — React 19 attaches
      // `wheel` as a passive listener at the root, so the *effect* of
      // `preventDefault()` is suppressed at the browser level (and
      // `evt.defaultPrevented` stays false). The synthetic event still
      // forwards the call to the native event, so the spy captures the
      // handler's intent. Asserting the spy is what we actually care
      // about — that the handler chose to claim the wheel event.
      const preventDefaultSpy = vi.spyOn(evt, 'preventDefault')
      fireEvent(viewport, evt)

      expect(viewport.scrollLeft).toBe(120)
      expect(preventDefaultSpy).toHaveBeenCalled()
    })

    it('leaves native horizontal scroll alone when deltaX dominates (trackpad swipe)', () => {
      seedFiveChips()
      const { container } = render(<RecentPagesStrip />)

      const viewport = container.querySelector(
        '[data-slot="scroll-area-viewport"]',
      ) as HTMLDivElement

      viewport.scrollLeft = 0
      const evt = new WheelEvent('wheel', {
        deltaY: 0,
        deltaX: 120,
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(evt, 'preventDefault')
      fireEvent(viewport, evt)

      // Handler must be a no-op when horizontal delta is dominant —
      // otherwise we'd double-scroll on top of the browser's native
      // horizontal trackpad gesture.
      expect(viewport.scrollLeft).toBe(0)
      expect(preventDefaultSpy).not.toHaveBeenCalled()
    })

    it('scrollIntoView fires on the focused chip during arrow-key traversal', async () => {
      const user = userEvent.setup()
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
      seedFiveChips()

      render(<RecentPagesStrip />)

      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      // Tab onto the first chip; the focus-management effect runs and
      // scrolls it into view. ArrowRight then advances focus and fires
      // a second scrollIntoView call on the next chip.
      await user.tab()
      await user.keyboard('{ArrowRight}')

      expect(scrollSpy).toHaveBeenCalled()
      const lastCallArgs = scrollSpy.mock.calls.at(-1)?.[0]
      expect(lastCallArgs).toMatchObject({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      })
      // The most recent invocation is on the chip that just received focus.
      expect(scrollSpy.mock.contexts.at(-1)).toBe(chips[1])

      scrollSpy.mockRestore()
    })

    it('honours prefers-reduced-motion → behavior: auto', async () => {
      const user = userEvent.setup()
      const originalMatchMedia = window.matchMedia
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia

      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
      seedFiveChips()

      render(<RecentPagesStrip />)

      await user.tab()
      await user.keyboard('{ArrowRight}')

      expect(scrollSpy).toHaveBeenCalled()
      const lastCallArgs = scrollSpy.mock.calls.at(-1)?.[0]
      expect(lastCallArgs).toMatchObject({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'auto',
      })

      scrollSpy.mockRestore()
      window.matchMedia = originalMatchMedia
    })

    it('has no a11y violations with the ScrollArea wrapper in place', async () => {
      seedFiveChips()
      const { container } = render(<RecentPagesStrip />)

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })

  // ---------------------------------------------------------------------------
  // keyboard navigation (UX-256)
  // ---------------------------------------------------------------------------
  describe('keyboard navigation (UX-256)', () => {
    // Helper: recordVisit is MRU — the newest visit is at index 0. Using a
    // stable seeder so the rendered chip order is predictable across tests.
    // After seeding A, B, C the store holds [C, B, A]; the strip renders
    // them in that order.
    function seedThreeChips() {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })
    }

    it('ArrowRight on the first chip moves focus to the second chip', async () => {
      const user = userEvent.setup()
      seedThreeChips()

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')
      expect(chips).toHaveLength(3)

      // Tab lands on the chip with tabIndex=0 — the focused one (idx 0 on mount).
      await user.tab()
      expect(document.activeElement).toBe(chips[0])

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(chips[1])
    })

    it('ArrowRight on the last chip wraps to the first', async () => {
      const user = userEvent.setup()
      seedThreeChips()

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      // Advance focus to the last chip via successive ArrowRight presses.
      await user.tab()
      await user.keyboard('{ArrowRight}{ArrowRight}')
      expect(document.activeElement).toBe(chips[2])

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(chips[0])
    })

    it('ArrowLeft mirrors ArrowRight in reverse (wraps at the start)', async () => {
      const user = userEvent.setup()
      seedThreeChips()

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      // Focus the middle chip first.
      await user.tab()
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(chips[1])

      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(chips[0])

      // Wrap: ArrowLeft on the first chip jumps to the last.
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(chips[2])
    })

    it('Enter on a focused chip calls navigateToPage with the right pageRef', async () => {
      const user = userEvent.setup()
      const navigateSpy = vi.fn()
      useTabsStore.setState({ navigateToPage: navigateSpy })

      const { recordVisit } = useRecentPagesStore.getState()
      // MRU order after: [Bravo, Alpha] — chip 0 is Bravo, chip 1 is Alpha.
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      await user.tab()
      expect(document.activeElement).toBe(chips[0])
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(chips[1])

      await user.keyboard('{Enter}')

      expect(navigateSpy).toHaveBeenCalledTimes(1)
      expect(navigateSpy).toHaveBeenCalledWith('A', 'Alpha')
    })

    // `useListKeyboardNavigation` treats Enter and Space identically as
    // activation keys (hook source line 159). This parity test pins the
    // Space path so a future refactor that narrows the match to Enter-only
    // doesn't silently break Space activation.
    it('Space on a focused chip calls navigateToPage with the right pageRef', async () => {
      const user = userEvent.setup()
      const navigateSpy = vi.fn()
      useTabsStore.setState({ navigateToPage: navigateSpy })

      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      await user.tab()
      expect(document.activeElement).toBe(chips[0])
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(chips[1])

      await user.keyboard(' ')

      expect(navigateSpy).toHaveBeenCalledTimes(1)
      expect(navigateSpy).toHaveBeenCalledWith('A', 'Alpha')
    })

    it('uses roving tabindex — exactly one chip is in the Tab sequence', () => {
      seedThreeChips()
      render(<RecentPagesStrip />)

      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')
      expect(chips).toHaveLength(3)

      const tabIndexes = chips.map((c) => c.getAttribute('tabindex'))
      // Exactly one chip tabIndex=0, the rest -1.
      const focusable = tabIndexes.filter((t) => t === '0')
      const unfocusable = tabIndexes.filter((t) => t === '-1')
      expect(focusable).toHaveLength(1)
      expect(unfocusable).toHaveLength(2)
    })

    it('ArrowUp / ArrowDown are no-ops inside the horizontal chip strip', async () => {
      const user = userEvent.setup()
      seedThreeChips()

      render(<RecentPagesStrip />)
      const strip = screen.getByTestId('recent-pages-strip')
      const chips = within(strip).getAllByRole('button')

      await user.tab()
      expect(document.activeElement).toBe(chips[0])

      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(chips[0])

      await user.keyboard('{ArrowUp}')
      expect(document.activeElement).toBe(chips[0])
    })

    it('has no a11y violations with keyboard navigation wired up', async () => {
      seedThreeChips()
      const { container } = render(<RecentPagesStrip />)

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })
})
