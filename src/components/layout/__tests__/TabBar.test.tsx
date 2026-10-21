import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TabBar } from '@/components/layout/TabBar'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'
import { resetTabIdCounter, selectPageStack, useTabsStore } from '@/stores/tabs'

// `useIsMobile` is mocked so each test can pin the viewport-state boolean
// without juggling `window.innerWidth` or matchMedia. The default (false)
// matches the existing tests that assume desktop rendering.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

import { useIsMobile } from '@/hooks/useIsMobile'

const mockedUseIsMobile = vi.mocked(useIsMobile)

/** Helper to reset the store to a clean initial state. */
function resetStore() {
  resetTabIdCounter()
  useNavigationStore.setState({
    currentView: 'page-editor',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
}

describe('TabBar', () => {
  beforeEach(() => {
    resetStore()
    mockedUseIsMobile.mockReturnValue(false)
  })

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------
  describe('rendering', () => {
    it('returns null when only a single tab is open', () => {
      const { container } = render(<TabBar />)
      expect(container.innerHTML).toBe('')
    })

    it('renders tab bar when multiple tabs are open', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tablist = screen.getByRole('tablist')
      expect(tablist).toBeInTheDocument()

      const tabs = within(tablist).getAllByRole('tab')
      expect(tabs).toHaveLength(2)
    })

    it('displays tab labels', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'My Notes' }], label: 'My Notes' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Project' }], label: 'Project' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      expect(screen.getByText('My Notes')).toBeInTheDocument()
      expect(screen.getByText('Project')).toBeInTheDocument()
    })

    it('displays "Untitled" for tabs with empty labels', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [], label: '' },
          { id: '1', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
        ],
        activeTabIndex: 1,
      })

      render(<TabBar />)

      expect(screen.getByText(t('tabs.untitled'))).toBeInTheDocument()
    })

    it('marks the active tab with aria-selected=true', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    })
  })

  // ---------------------------------------------------------------------------
  // interactions
  // ---------------------------------------------------------------------------
  describe('interactions', () => {
    it('clicking a tab switches to it', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 1'))

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('clicking close icon removes the tab', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      const user = userEvent.setup()
      const { container } = render(<TabBar />)

      // Click the close icon on the second tab
      const closeIcons = container.querySelectorAll('[data-tab-close]')
      await user.click(closeIcons[1] as HTMLElement)

      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.label).toBe('Page 1')
    })

    it('pressing Delete key on a tab closes it', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      const user = userEvent.setup()
      render(<TabBar />)

      // Focus the second tab and press Delete
      const tabs = screen.getAllByRole('tab')
      ;(tabs[1] as HTMLElement).focus()
      await user.keyboard('{Delete}')

      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.label).toBe('Page 1')
    })

    // #1172 — the `closeTabOnFocus` binding is `Delete / Backspace`. The Delete
    // alternative is covered above; this pins the Backspace alternative so the
    // catalog's second key never silently rots.
    it('pressing Backspace key on a tab closes it (closeTabOnFocus alternative)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      // Focus the second tab and press Backspace — closes the focused (not the
      // active) tab.
      const tabs = screen.getAllByRole('tab')
      ;(tabs[1] as HTMLElement).focus()
      fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'Backspace' })

      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.label).toBe('Page 1')
    })

    it('a non-close key on a focused tab does not close it (closeTabOnFocus gate)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      ;(tabs[1] as HTMLElement).focus()
      // A plain letter must NOT trigger the close path.
      fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'a' })

      expect(useTabsStore.getState().tabs).toHaveLength(2)
    })

    it('close icon on inactive tab does not switch to it', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      const user = userEvent.setup()
      const { container } = render(<TabBar />)

      // Close tab 0 (not the active tab)
      const closeIcons = container.querySelectorAll('[data-tab-close]')
      await user.click(closeIcons[0] as HTMLElement)

      // Should not switch — tab 0 closed, active should still be the remaining tab

      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.label).toBe('Page 2')
    })
  })

  // ---------------------------------------------------------------------------
  // keyboard navigation (T-35)
  // ---------------------------------------------------------------------------
  describe('keyboard navigation', () => {
    function setupThreeTabs(activeTabIndex: number) {
      const tabs = [
        { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
        { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
      ]
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs,
        activeTabIndex,
      })
    }

    it('ArrowRight switches to next tab', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' })

      expect(useTabsStore.getState().activeTabIndex).toBe(1)
    })

    it('ArrowLeft switches to previous tab', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'ArrowLeft' })

      expect(useTabsStore.getState().activeTabIndex).toBe(1)
    })

    it('ArrowRight wraps from last to first', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'ArrowRight' })

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })

    it('ArrowLeft wraps from first to last', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowLeft' })

      expect(useTabsStore.getState().activeTabIndex).toBe(2)
    })

    it('Home goes to first tab', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'Home' })

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })

    it('End goes to last tab', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' })

      expect(useTabsStore.getState().activeTabIndex).toBe(2)
    })
  })

  // ---------------------------------------------------------------------------
  // a11y
  // ---------------------------------------------------------------------------
  describe('accessibility', () => {
    it('has no a11y violations with multiple tabs', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      const { container } = render(<TabBar />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has tablist role on the container', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      expect(screen.getByRole('tablist')).toBeInTheDocument()
    })

    it('has tab role on each tab element', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(2)
    })

    it('close icons are present in each tab', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      const { container } = render(<TabBar />)

      const closeIcons = container.querySelectorAll('[data-tab-close]')
      expect(closeIcons).toHaveLength(2)
    })

    // Horizontal ScrollArea replaces bare overflow-x-auto
    it('renders inside a horizontal ScrollArea', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      const { container } = render(<TabBar />)

      // Outer wrapper is a ScrollArea (Radix Root) with its viewport.
      const scrollArea = container.querySelector('[data-slot="scroll-area"]')
      expect(scrollArea).toBeInTheDocument()
      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport).toBeInTheDocument()

      // The tablist is inside the viewport.
      const tablist = screen.getByRole('tablist')
      expect(viewport).toContainElement(tablist)

      // No bare overflow-x-auto class anywhere.
      const anyOverflowX = container.querySelector('.overflow-x-auto')
      expect(anyOverflowX).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Responsive layout
  // ---------------------------------------------------------------------------
  describe(' responsive layout', () => {
    function setupThreeTabs() {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
        ],
        activeTabIndex: 0,
      })
    }

    it('tablist has min-w-0 so it can shrink inside the horizontal ScrollArea', () => {
      setupThreeTabs()
      render(<TabBar />)

      const tablist = screen.getByRole('tablist')
      expect(tablist).toHaveClass('min-w-0')
    })

    it('each tab uses a responsive max-width (120px mobile → 200px md+)', () => {
      setupThreeTabs()
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs.length).toBeGreaterThanOrEqual(3)
      for (const tab of tabs) {
        expect(tab).toHaveClass('max-w-[120px]')
        expect(tab).toHaveClass('md:max-w-[200px]')
        // truncate behaviour must be preserved so long titles stay on one line.
        expect(tab).toHaveClass('truncate')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Shell-level hoist
  // ---------------------------------------------------------------------------
  describe(' shell-level hoist', () => {
    function setupThreeTabs(currentView: 'page-editor' | 'journal' | 'pages' = 'page-editor') {
      useNavigationStore.setState({
        currentView,
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
        ],
        activeTabIndex: 0,
      })
    }

    it('renders when tabs.length > 1 regardless of currentView (journal)', () => {
      setupThreeTabs('journal')
      render(<TabBar />)

      expect(screen.getByRole('tablist')).toBeInTheDocument()
    })

    it('renders when tabs.length > 1 regardless of currentView (pages)', () => {
      setupThreeTabs('pages')
      render(<TabBar />)

      expect(screen.getByRole('tablist')).toBeInTheDocument()
    })

    it('single-tab autohide still applies in a non-editor view', () => {
      useNavigationStore.setState({
        currentView: 'journal',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })
      render(<TabBar />)

      expect(screen.queryByRole('tablist')).toBeNull()
    })

    it('mobile viewport hides the bar entirely even with many tabs', () => {
      mockedUseIsMobile.mockReturnValue(true)
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: Array.from({ length: 5 }, (_, i) => ({
          id: String(i),
          pageStack: [{ pageId: `P${i}`, title: `Page ${i}` }],
          label: `Page ${i}`,
        })),
        activeTabIndex: 0,
      })

      render(<TabBar />)

      expect(screen.queryByRole('tablist')).toBeNull()
    })

    // The tab covers the strip's hairline with the page background, and its
    // one border is the square-cornered top bar (#5924).
    const ATTACHED = ['bg-background', '-mb-px', 'border-t-2', 'border-t-tab-indicator']

    it('active tab is attached to the content with ink text while currentView === "page-editor"', () => {
      setupThreeTabs('page-editor')
      render(<TabBar />)

      const [active, inactive] = screen.getAllByRole('tab') as HTMLElement[]
      expect(screen.getByRole('tablist')).toHaveClass('border-b', 'border-border')
      expect(active).toHaveClass(...ATTACHED, 'text-foreground', 'font-medium')
      expect(active?.className).not.toMatch(/\brounded|\bborder(-[xyblr])?(-\d)?(?=\s|$)|shadow/)
      expect(inactive).toHaveClass('border-t-transparent', 'text-muted-foreground')
      expect(inactive).not.toHaveClass('bg-background')
    })

    it('active tab keeps the attached shape with muted text while currentView !== "page-editor"', () => {
      setupThreeTabs('journal')
      render(<TabBar />)

      const active = screen.getAllByRole('tab')[0] as HTMLElement
      expect(active).toHaveClass(...ATTACHED, 'text-muted-foreground')
      expect(active).not.toHaveClass('font-medium')
      expect(active.className).not.toMatch(/sidebar-accent|\brounded/)
    })

    it('clicking a non-active tab from a non-editor view switches tab and flips to page-editor', async () => {
      setupThreeTabs('journal')
      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 2'))

      const state = useNavigationStore.getState()
      expect(useTabsStore.getState().activeTabIndex).toBe(1)
      expect(state.currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // Tab switcher (#5993)
  // ---------------------------------------------------------------------------
  describe('tab switcher', () => {
    function setupTabs(labels: string[], activeTabIndex = 0) {
      useNavigationStore.setState({ currentView: 'page-editor' })
      useTabsStore.setState({
        tabs: labels.map((label, i) => ({
          id: String(i),
          pageStack: [{ pageId: `P${i}`, title: label }],
          label,
        })),
        activeTabIndex,
      })
    }

    async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: t('tabs.switcher') }))
      return screen.findByRole('combobox')
    }

    function optionLabels(): string[] {
      return screen.getAllByRole('option').map((o) => o.getAttribute('title') ?? '')
    }

    it('renders the caret before the tablist, outside it', () => {
      setupTabs(['Page 1', 'Page 2', 'Page 3'], 1)
      render(<TabBar />)

      const caret = screen.getByRole('button', { name: t('tabs.switcher') })
      const tablist = screen.getByRole('tablist')
      expect(tablist).not.toContainElement(caret)
      expect(caret.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('opens with focus in the filter and lists every tab', async () => {
      setupTabs(['Page 1', 'Page 2', 'Page 3'], 1)
      const user = userEvent.setup()
      render(<TabBar />)

      const input = await openSwitcher(user)

      await waitFor(() => expect(input).toHaveFocus())
      expect(optionLabels()).toEqual(['Page 1', 'Page 2', 'Page 3'])
    })

    it('opens with the active tab highlighted', async () => {
      setupTabs(['Page 1', 'Page 2', 'Page 3'], 1)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      expect(screen.getByRole('option', { name: /Page 2/ })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await user.keyboard('{ArrowDown}{Enter}')

      expect(useTabsStore.getState().activeTabIndex).toBe(2)
    })

    it('typing narrows the list by a case-insensitive substring of the label or full path', async () => {
      setupTabs(['Work/Alpha', 'Beta', 'work notes'], 1)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      // `WORK` is only in the hidden namespace of the first tab (shown as
      // "Alpha") and in the third tab's label.
      await user.keyboard('WORK')

      expect(optionLabels()).toEqual(['Work/Alpha', 'work notes'])
    })

    it('shows the no-match row when nothing matches', async () => {
      setupTabs(['Page 1', 'Page 2'])
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      await user.keyboard('zzz')

      expect(screen.queryAllByRole('option')).toHaveLength(0)
      expect(screen.getByText(t('tabs.switcherNoMatch'))).toBeInTheDocument()
    })

    it('ArrowDown then Enter activates the highlighted match and closes the switcher', async () => {
      setupTabs(['Alpha', 'Beta', 'Gamma'], 0)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      await user.keyboard('a')
      // Matches: Alpha, Beta, Gamma; the first is highlighted.
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

      expect(useTabsStore.getState().activeTabIndex).toBe(2)
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    })

    it('clicking a row activates that tab', async () => {
      setupTabs(['Alpha', 'Beta'], 0)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      await user.click(screen.getByRole('option', { name: /Beta/ }))

      expect(useTabsStore.getState().activeTabIndex).toBe(1)
    })

    it('Escape closes the switcher without switching tabs', async () => {
      setupTabs(['Alpha', 'Beta'], 0)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })

    it("a row's close closes that tab only and keeps the switcher open", async () => {
      setupTabs(['Alpha', 'Beta', 'Gamma'], 0)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)
      const betaRow = screen.getByRole('option', { name: /Beta/ })
      await user.click(betaRow.querySelector('[data-tab-switcher-close]') as HTMLElement)

      expect(useTabsStore.getState().tabs.map((tab) => tab.label)).toEqual(['Alpha', 'Gamma'])
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(optionLabels()).toEqual(['Alpha', 'Gamma'])
    })

    it('has no a11y violations while open', async () => {
      setupTabs(['Alpha', 'Beta', 'Gamma'], 1)
      const user = userEvent.setup()
      render(<TabBar />)

      await openSwitcher(user)

      expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations()
    })
  })
})
