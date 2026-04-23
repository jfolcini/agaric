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
import { useIsMobile } from '../../hooks/use-mobile'
import { useNavigationStore } from '../../stores/navigation'
import { useRecentPagesStore } from '../../stores/recent-pages'
import { RecentPagesStrip } from '../RecentPagesStrip'

vi.mock('../../hooks/use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedUseIsMobile = vi.mocked(useIsMobile)

function seedTab(pageId: string, title: string) {
  useNavigationStore.setState({
    currentView: 'page-editor',
    tabs: [{ id: '0', pageStack: [{ pageId, title }], label: title }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
}

function clearActiveTab() {
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
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
    useNavigationStore.setState({ navigateToPage: navigateSpy })

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
    useNavigationStore.setState({
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
    useNavigationStore.setState({
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
    useNavigationStore.setState({
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
      useNavigationStore.setState({ navigateToPage: navigateSpy })

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
      useNavigationStore.setState({ navigateToPage: navigateSpy })

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
