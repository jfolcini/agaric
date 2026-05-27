/**
 * Tests for QuickAccessBar (PEND-68 Part B).
 *
 * Two zones, one nav element:
 *  - Destinations cluster (Pages / Tags / Graph / Search), with active state
 *    + `aria-current="page"` and `setView` dispatch.
 *  - Recents scroller (existing PEND-32 behaviour — kept verbatim).
 *
 * Coverage:
 *  - Renders even when recents is empty (new render gate: destinations is a
 *    4-entry constant so the bar is effectively always present on desktop).
 *  - Destination click → `setView(view)`.
 *  - Active destination carries `aria-current="page"`.
 *  - Keyboard traversal spans destinations → recents with wrap.
 *  - Recents zone preserves all FEAT-9 / PEND-19 / PEND-32 / UX-256 behaviour.
 *  - Mobile → null.
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
import { QUICK_NAV_DESTINATIONS, QuickAccessBar } from '../QuickAccessBar'

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

/** Helper: scope a query to the recents scroller viewport (excludes destinations). */
function getRecentsZone(): HTMLElement {
  const bar = screen.getByTestId('quick-access-bar')
  const viewport = bar.querySelector('[data-slot="scroll-area-viewport"]')
  if (!viewport) throw new Error('no recents scroll-area viewport')
  return viewport as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(false)
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
  clearActiveTab()
  localStorage.clear()
})

describe('QuickAccessBar', () => {
  // ---------------------------------------------------------------------------
  // Render gate (PEND-68 change-of-behaviour)
  // ---------------------------------------------------------------------------

  describe('render gate', () => {
    it('renders on desktop even when recents is empty (destinations always non-empty)', () => {
      render(<QuickAccessBar />)
      expect(screen.getByTestId('quick-access-bar')).toBeInTheDocument()
      expect(screen.getByTestId('quick-access-destinations')).toBeInTheDocument()
    })

    it('renders all 4 destination chips', () => {
      render(<QuickAccessBar />)
      const dest = screen.getByTestId('quick-access-destinations')
      const chips = within(dest).getAllByRole('button')
      expect(chips).toHaveLength(QUICK_NAV_DESTINATIONS.length)
      expect(chips).toHaveLength(4)
    })

    it('hides on mobile', () => {
      mockedUseIsMobile.mockReturnValue(true)
      render(<QuickAccessBar />)
      expect(screen.queryByTestId('quick-access-bar')).toBeNull()
    })

    it('still excludes the currently-open page from the recents zone', () => {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })

      seedTab('B', 'Bravo')

      render(<QuickAccessBar />)

      const recents = getRecentsZone()
      const chips = within(recents).getAllByRole('button')
      const labels = chips.map((c) => c.textContent)
      expect(labels).toContain('Alpha')
      expect(labels).toContain('Charlie')
      expect(labels).not.toContain('Bravo')
    })
  })

  // ---------------------------------------------------------------------------
  // Destinations cluster
  // ---------------------------------------------------------------------------

  describe('destinations', () => {
    it('renders icon + label for each destination (sidebar.* labels)', () => {
      render(<QuickAccessBar />)
      expect(screen.getByRole('button', { name: 'Pages' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Graph' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    })

    it('clicking a destination calls setView with the right view', async () => {
      const user = userEvent.setup()
      const setViewSpy = vi.fn()
      useNavigationStore.setState({ setView: setViewSpy })

      render(<QuickAccessBar />)

      await user.click(screen.getByRole('button', { name: 'Tags' }))
      expect(setViewSpy).toHaveBeenCalledTimes(1)
      expect(setViewSpy).toHaveBeenCalledWith('tags')

      await user.click(screen.getByRole('button', { name: 'Graph' }))
      expect(setViewSpy).toHaveBeenCalledTimes(2)
      expect(setViewSpy).toHaveBeenLastCalledWith('graph')
    })

    it('flags the active destination with aria-current="page"', () => {
      useNavigationStore.setState({ currentView: 'tags' })
      render(<QuickAccessBar />)

      const tags = screen.getByRole('button', { name: 'Tags' })
      const pages = screen.getByRole('button', { name: 'Pages' })

      expect(tags).toHaveAttribute('aria-current', 'page')
      expect(pages).not.toHaveAttribute('aria-current')
    })

    it('active destination chip carries data-active="true" (palette hook)', () => {
      useNavigationStore.setState({ currentView: 'search' })
      render(<QuickAccessBar />)

      const search = screen.getByRole('button', { name: 'Search' })
      expect(search.getAttribute('data-active')).toBe('true')

      const pages = screen.getByRole('button', { name: 'Pages' })
      expect(pages.getAttribute('data-active')).toBeNull()
    })

    it('updates aria-current when currentView changes', () => {
      useNavigationStore.setState({ currentView: 'pages' })
      const { rerender } = render(<QuickAccessBar />)

      expect(screen.getByRole('button', { name: 'Pages' })).toHaveAttribute('aria-current', 'page')

      useNavigationStore.setState({ currentView: 'graph' })
      rerender(<QuickAccessBar />)

      expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('button', { name: 'Pages' })).not.toHaveAttribute('aria-current')
    })

    it('destination click does NOT route through openInNewTab even with Ctrl', () => {
      // Views aren't tabs — Ctrl+click on a destination still just switches view.
      const setViewSpy = vi.fn()
      const openInNewTabSpy = vi.fn()
      useNavigationStore.setState({ setView: setViewSpy })
      useTabsStore.setState({ openInNewTab: openInNewTabSpy })

      render(<QuickAccessBar />)

      const pages = screen.getByRole('button', { name: 'Pages' })
      fireEvent.click(pages, { ctrlKey: true })

      expect(setViewSpy).toHaveBeenCalledTimes(1)
      expect(setViewSpy).toHaveBeenCalledWith('pages')
      expect(openInNewTabSpy).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Recents zone — preserved behaviour
  // ---------------------------------------------------------------------------

  describe('recents zone (preserved behaviour)', () => {
    it('renders all retained pages as chips', () => {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })
      recordVisit({ pageId: 'D', title: 'Delta' })

      render(<QuickAccessBar />)

      const recents = getRecentsZone()
      const chips = within(recents).getAllByRole('button')
      expect(chips).toHaveLength(4)
    })

    it('click navigates to the page', async () => {
      const user = userEvent.setup()
      const navigateSpy = vi.fn()
      useTabsStore.setState({ navigateToPage: navigateSpy })

      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<QuickAccessBar />)

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

      render(<QuickAccessBar />)

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

      render(<QuickAccessBar />)

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

      render(<QuickAccessBar />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      fireEvent(chip, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))

      expect(openInNewTabSpy).toHaveBeenCalledTimes(1)
      expect(openInNewTabSpy).toHaveBeenCalledWith('A', 'Alpha')
      expect(navigateSpy).not.toHaveBeenCalled()
    })

    it('renders a title attribute on long titles', () => {
      const longTitle = 'A very long page title that will likely truncate in the chip'
      useRecentPagesStore.getState().recordVisit({ pageId: 'LONG', title: longTitle })

      render(<QuickAccessBar />)

      const chip = screen.getByRole('button', { name: longTitle })
      expect(chip).toHaveAttribute('title', longTitle)
    })

    it('falls back to "Untitled" when the title is empty', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: '' })

      render(<QuickAccessBar />)

      const chip = screen.getByRole('button', { name: 'Untitled' })
      expect(chip).toBeInTheDocument()
      expect(chip).toHaveAttribute('title', 'Untitled')
    })

    it('chips carry the focus-tint class for keyboard discoverability (UX-284)', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<QuickAccessBar />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      expect(chip.className).toContain('focus-visible:bg-accent/60')
    })

    it('recent chips render with the recent-page-chip data-slot', () => {
      useRecentPagesStore.getState().recordVisit({ pageId: 'A', title: 'Alpha' })

      render(<QuickAccessBar />)

      const chip = screen.getByRole('button', { name: 'Alpha' })
      expect(chip.getAttribute('data-slot')).toBe('recent-page-chip')
    })
  })

  // ---------------------------------------------------------------------------
  // Keyboard model spans destinations → recents
  // ---------------------------------------------------------------------------

  describe('keyboard navigation across zones', () => {
    function seedTwoRecents() {
      const { recordVisit } = useRecentPagesStore.getState()
      // MRU: after seeding A, B the store holds [Bravo, Alpha].
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
    }

    it('roving tabindex: exactly one chip in the Tab sequence across both zones', () => {
      seedTwoRecents()
      render(<QuickAccessBar />)

      const bar = screen.getByTestId('quick-access-bar')
      const allChips = within(bar).getAllByRole('button')
      // 4 destinations + 2 recents
      expect(allChips).toHaveLength(6)

      const focusable = allChips.filter((c) => c.getAttribute('tabindex') === '0')
      const unfocusable = allChips.filter((c) => c.getAttribute('tabindex') === '-1')
      expect(focusable).toHaveLength(1)
      expect(unfocusable).toHaveLength(5)
    })

    it('ArrowRight traverses destinations → recents in order', async () => {
      const user = userEvent.setup()
      seedTwoRecents()
      render(<QuickAccessBar />)

      const bar = screen.getByTestId('quick-access-bar')
      const allChips = within(bar).getAllByRole('button')
      // Order: [Pages, Tags, Graph, Search, Bravo, Alpha]
      expect(allChips.map((c) => c.textContent)).toEqual([
        'Pages',
        'Tags',
        'Graph',
        'Search',
        'Bravo',
        'Alpha',
      ])

      // Tab onto the first chip (the destination "Pages").
      await user.tab()
      expect(document.activeElement).toBe(allChips[0])

      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(allChips[1]) // Tags

      await user.keyboard('{ArrowRight}{ArrowRight}')
      expect(document.activeElement).toBe(allChips[3]) // Search (last destination)

      await user.keyboard('{ArrowRight}')
      // Crosses zone boundary into recents.
      expect(document.activeElement).toBe(allChips[4]) // Bravo
    })

    it('ArrowRight wraps from the last recent back to the first destination', async () => {
      const user = userEvent.setup()
      seedTwoRecents()
      render(<QuickAccessBar />)

      const bar = screen.getByTestId('quick-access-bar')
      const allChips = within(bar).getAllByRole('button')

      // Advance to the last item (Alpha — index 5).
      await user.tab()
      for (let i = 0; i < 5; i++) await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(allChips[5])

      // One more ArrowRight wraps to the first destination (Pages).
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(allChips[0])
    })

    it('ArrowLeft from the first destination wraps to the last recent', async () => {
      const user = userEvent.setup()
      seedTwoRecents()
      render(<QuickAccessBar />)

      const bar = screen.getByTestId('quick-access-bar')
      const allChips = within(bar).getAllByRole('button')

      await user.tab()
      expect(document.activeElement).toBe(allChips[0]) // Pages

      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toBe(allChips[5]) // Alpha (last recent)
    })

    it('Enter on a focused destination calls setView, not navigateToPage', async () => {
      const user = userEvent.setup()
      const setViewSpy = vi.fn()
      const navigateSpy = vi.fn()
      useNavigationStore.setState({ setView: setViewSpy })
      useTabsStore.setState({ navigateToPage: navigateSpy })

      seedTwoRecents()
      render(<QuickAccessBar />)

      // Focus the first destination (Pages — index 0).
      await user.tab()
      await user.keyboard('{Enter}')

      expect(setViewSpy).toHaveBeenCalledTimes(1)
      expect(setViewSpy).toHaveBeenCalledWith('pages')
      expect(navigateSpy).not.toHaveBeenCalled()
    })

    it('Enter on a focused recent calls navigateToPage, not setView', async () => {
      const user = userEvent.setup()
      const setViewSpy = vi.fn()
      const navigateSpy = vi.fn()
      useNavigationStore.setState({ setView: setViewSpy })
      useTabsStore.setState({ navigateToPage: navigateSpy })

      seedTwoRecents()
      render(<QuickAccessBar />)

      // Focus the first recent — 4 ArrowRights past the destinations.
      await user.tab()
      await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}')
      // Now on Bravo (index 4 = first recent).
      await user.keyboard('{Enter}')

      expect(navigateSpy).toHaveBeenCalledTimes(1)
      expect(navigateSpy).toHaveBeenCalledWith('B', 'Bravo')
      expect(setViewSpy).not.toHaveBeenCalled()
    })

    it('Space activates the same as Enter (dispatches by item kind)', async () => {
      const user = userEvent.setup()
      const setViewSpy = vi.fn()
      useNavigationStore.setState({ setView: setViewSpy })

      render(<QuickAccessBar />)
      await user.tab()
      await user.keyboard(' ')

      expect(setViewSpy).toHaveBeenCalledWith('pages')
    })

    it('ArrowUp / ArrowDown are no-ops (horizontal mode)', async () => {
      const user = userEvent.setup()
      seedTwoRecents()
      render(<QuickAccessBar />)

      const bar = screen.getByTestId('quick-access-bar')
      const allChips = within(bar).getAllByRole('button')

      await user.tab()
      expect(document.activeElement).toBe(allChips[0])

      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(allChips[0])

      await user.keyboard('{ArrowUp}')
      expect(document.activeElement).toBe(allChips[0])
    })
  })

  // ---------------------------------------------------------------------------
  // Recents single-line / wheel / mask (preserved from PEND-32 / MAINT-211)
  // ---------------------------------------------------------------------------

  describe('recents scroller (PEND-32 / MAINT-211)', () => {
    function seedFive() {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })
      recordVisit({ pageId: 'C', title: 'Charlie' })
      recordVisit({ pageId: 'D', title: 'Delta' })
      recordVisit({ pageId: 'E', title: 'Echo' })
    }

    it('renders the recents row inside a horizontal ScrollArea', () => {
      seedFive()
      const { container } = render(<QuickAccessBar />)

      const scrollArea = container.querySelector('[data-slot="scroll-area"]')
      expect(scrollArea).not.toBeNull()

      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport).not.toBeNull()

      // One scroll area, never two.
      expect(container.querySelectorAll('[data-slot="scroll-area"]')).toHaveLength(1)

      // Inner recents row is a single-line flex container.
      const innerRow = viewport?.querySelector('div.flex')
      expect(innerRow?.className).toContain('flex')
      expect(innerRow?.className).not.toContain('flex-wrap')
    })

    it('translates dominant vertical wheel deltas to horizontal scroll', () => {
      seedFive()
      const { container } = render(<QuickAccessBar />)

      const viewport = container.querySelector(
        '[data-slot="scroll-area-viewport"]',
      ) as HTMLDivElement

      viewport.scrollLeft = 0
      const evt = new WheelEvent('wheel', {
        deltaY: 120,
        deltaX: 0,
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(evt, 'preventDefault')
      fireEvent(viewport, evt)

      expect(viewport.scrollLeft).toBe(120)
      expect(preventDefaultSpy).toHaveBeenCalled()
    })

    it('leaves native horizontal scroll alone when deltaX dominates', () => {
      seedFive()
      const { container } = render(<QuickAccessBar />)

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

      expect(viewport.scrollLeft).toBe(0)
      expect(preventDefaultSpy).not.toHaveBeenCalled()
    })

    it('scrollIntoView fires on the focused chip during arrow traversal', async () => {
      const user = userEvent.setup()
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
      seedFive()

      render(<QuickAccessBar />)

      await user.tab()
      await user.keyboard('{ArrowRight}')

      expect(scrollSpy).toHaveBeenCalled()
      const lastCallArgs = scrollSpy.mock.calls.at(-1)?.[0]
      expect(lastCallArgs).toMatchObject({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'smooth',
      })

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
      seedFive()

      render(<QuickAccessBar />)
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

    it('does not apply mask-image when there is no overflow', async () => {
      const { recordVisit } = useRecentPagesStore.getState()
      for (let i = 0; i < 20; i++) {
        recordVisit({ pageId: `P${i}`, title: `Page ${i}` })
      }

      class FiringRO {
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb
        }
        observe(target: Element): void {
          queueMicrotask(() => {
            this.cb(
              [{ target } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            )
          })
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal('ResizeObserver', FiringRO)

      const origScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
      const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        get() {
          if (this.getAttribute('data-slot') === 'scroll-area-viewport') return 100
          return origScrollWidth?.get?.call(this) ?? 0
        },
        configurable: true,
      })
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        get() {
          if (this.getAttribute('data-slot') === 'scroll-area-viewport') return 200
          return origClientWidth?.get?.call(this) ?? 0
        },
        configurable: true,
      })

      try {
        render(<QuickAccessBar />)
        const bar = screen.getByTestId('quick-access-bar')
        const viewport = bar.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
        await waitFor(() => {
          expect(viewport.style.maskImage ?? '').toBe('')
        })
      } finally {
        if (origScrollWidth)
          Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScrollWidth)
        if (origClientWidth)
          Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth)
      }
    })

    it('applies mask-image when viewport overflows', async () => {
      const { recordVisit } = useRecentPagesStore.getState()
      for (let i = 0; i < 20; i++) {
        recordVisit({ pageId: `P${i}`, title: `Page ${i}` })
      }

      class FiringRO {
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb
        }
        observe(target: Element): void {
          queueMicrotask(() => {
            this.cb(
              [{ target } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            )
          })
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal('ResizeObserver', FiringRO)

      const origScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
      const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        get() {
          if (this.getAttribute('data-slot') === 'scroll-area-viewport') return 400
          return origScrollWidth?.get?.call(this) ?? 0
        },
        configurable: true,
      })
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        get() {
          if (this.getAttribute('data-slot') === 'scroll-area-viewport') return 200
          return origClientWidth?.get?.call(this) ?? 0
        },
        configurable: true,
      })

      try {
        render(<QuickAccessBar />)
        const bar = screen.getByTestId('quick-access-bar')
        const viewport = bar.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement
        await waitFor(() => {
          expect(viewport.style.maskImage).toBe('linear-gradient(to right, black 90%, transparent)')
        })
      } finally {
        if (origScrollWidth)
          Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origScrollWidth)
        if (origClientWidth)
          Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // a11y audit
  // ---------------------------------------------------------------------------

  describe('a11y', () => {
    it('has no axe violations when only destinations render', async () => {
      const { container } = render(<QuickAccessBar />)

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })

    it('has no axe violations when both zones render', async () => {
      const { recordVisit } = useRecentPagesStore.getState()
      recordVisit({ pageId: 'A', title: 'Alpha' })
      recordVisit({ pageId: 'B', title: 'Bravo' })

      const { container } = render(<QuickAccessBar />)

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
