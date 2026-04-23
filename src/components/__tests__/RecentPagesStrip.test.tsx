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
})
