import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { resetTabIdCounter, selectPageStack, useNavigationStore } from '../../stores/navigation'
import { TabBar } from '../TabBar'

// `useIsMobile` is mocked so each test can pin the viewport-state boolean
// without juggling `window.innerWidth` or matchMedia. The default (false)
// matches the existing tests that assume desktop rendering.
vi.mock('../../hooks/use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

import { useIsMobile } from '../../hooks/use-mobile'

const mockedUseIsMobile = vi.mocked(useIsMobile)

/** Helper to reset the store to a clean initial state. */
function resetStore() {
  resetTabIdCounter()
  useNavigationStore.setState({
    currentView: 'page-editor',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
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
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 1'))

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('clicking close icon removes the tab', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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

      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.label).toBe('Page 1')
    })

    it('pressing Delete key on a tab closes it', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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

      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.label).toBe('Page 1')
    })

    it('close icon on inactive tab does not switch to it', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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
      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.label).toBe('Page 2')
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
        tabs,
        activeTabIndex,
      })
    }

    it('ArrowRight switches to next tab', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(1)
    })

    it('ArrowLeft switches to previous tab', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'ArrowLeft' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(1)
    })

    it('ArrowRight wraps from last to first', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'ArrowRight' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(0)
    })

    it('ArrowLeft wraps from first to last', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowLeft' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(2)
    })

    it('Home goes to first tab', () => {
      setupThreeTabs(2)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'Home' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(0)
    })

    it('End goes to last tab', () => {
      setupThreeTabs(0)
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' })

      expect(useNavigationStore.getState().activeTabIndex).toBe(2)
    })
  })

  // ---------------------------------------------------------------------------
  // a11y
  // ---------------------------------------------------------------------------
  describe('accessibility', () => {
    it('has no a11y violations with multiple tabs', async () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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

    // UX-226: horizontal ScrollArea replaces bare overflow-x-auto
    it('renders inside a horizontal ScrollArea (UX-226)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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
  // UX-230 responsive layout
  // ---------------------------------------------------------------------------
  describe('UX-230 responsive layout', () => {
    function setupThreeTabs() {
      useNavigationStore.setState({
        currentView: 'page-editor',
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
  // FEAT-7 shell-level hoist
  // ---------------------------------------------------------------------------
  describe('FEAT-7 shell-level hoist', () => {
    function setupThreeTabs(currentView: 'page-editor' | 'journal' | 'pages' = 'page-editor') {
      useNavigationStore.setState({
        currentView,
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

    it('active tab uses filled/focused tokens while currentView === "page-editor"', () => {
      setupThreeTabs('page-editor')
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const active = tabs[0] as HTMLElement
      expect(active).toHaveClass('bg-background')
      expect(active).toHaveClass('border')
      expect(active).toHaveClass('font-medium')
    })

    it('active tab uses muted/outlined sidebar-accent tokens while currentView !== "page-editor"', () => {
      setupThreeTabs('journal')
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const active = tabs[0] as HTMLElement
      expect(active).toHaveClass('bg-sidebar-accent')
      expect(active).toHaveClass('text-sidebar-accent-foreground')
      expect(active).not.toHaveClass('bg-background')
    })

    it('clicking a non-active tab from a non-editor view switches tab and flips to page-editor', async () => {
      setupThreeTabs('journal')
      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 2'))

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(1)
      expect(state.currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // FEAT-8 active-tab dropdown switcher
  // ---------------------------------------------------------------------------
  describe('FEAT-8 active-tab dropdown switcher', () => {
    function setupThreeTabs(activeTabIndex = 1) {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
        ],
        activeTabIndex,
      })
    }

    it('clicking the active tab opens a dropdown listing every tab with the active one checked', async () => {
      setupThreeTabs(1)
      const user = userEvent.setup()
      render(<TabBar />)

      // Click the active tab's label — the active tab is at index 1 ("Page 2").
      await user.click(screen.getByText('Page 2'))

      const menu = await screen.findByRole('menu')
      expect(menu).toBeInTheDocument()

      const items = within(menu).getAllByRole('menuitemradio')
      expect(items).toHaveLength(3)
      expect(items[0]).toHaveAttribute('aria-checked', 'false')
      expect(items[1]).toHaveAttribute('aria-checked', 'true')
      expect(items[2]).toHaveAttribute('aria-checked', 'false')
    })

    it('clicking a dropdown item switches tabs and closes the menu', async () => {
      setupThreeTabs(1)
      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 2'))
      const menu = await screen.findByRole('menu')
      const items = within(menu).getAllByRole('menuitemradio')

      // Pick the 3rd row (index 2 → "Page 3").
      await user.click(items[2] as HTMLElement)

      expect(useNavigationStore.getState().activeTabIndex).toBe(2)
      // Menu has dismissed.
      await waitForMenuClosed()
    })

    it('clicking the close icon inside a dropdown row closes that tab but keeps the menu open', async () => {
      setupThreeTabs(1)
      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 2'))
      await screen.findByRole('menu')

      // Popover content is portaled — search document-wide, not just the
      // render container (Radix mounts the portal on document.body).
      const closeButtons = document.querySelectorAll('[data-tab-dropdown-close]')
      expect(closeButtons.length).toBe(3)
      await user.click(closeButtons[1] as HTMLElement)

      // closeTab(1) removed "Page 2" — 2 tabs remain, menu is still present,
      // and the remaining rows are re-rendered.
      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(2)
      expect(state.tabs.map((t) => t.label)).toEqual(['Page 1', 'Page 3'])
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('clicking the active tab from a non-editor view does not open the dropdown (flips view instead)', async () => {
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })
      const user = userEvent.setup()
      render(<TabBar />)

      await user.click(screen.getByText('Page 1'))

      expect(screen.queryByRole('menu')).toBeNull()
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // UX-254 chevron visual polish (discoverability of active-tab dropdown)
  // ---------------------------------------------------------------------------
  describe('UX-254 chevron visual polish', () => {
    function setupActiveInEditor() {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })
    }

    it('chevron on the active tab uses opacity-70 base + group-hover:opacity-100 reveal', () => {
      setupActiveInEditor()
      const { container } = render(<TabBar />)

      // Scope to the active tab (index 0) and find the single ChevronDown icon
      // rendered alongside the title span. lucide renders as an <svg>.
      const tabs = screen.getAllByRole('tab')
      const activeTab = tabs[0] as HTMLElement
      const chevron = activeTab.querySelector('svg.lucide-chevron-down')
      expect(chevron).not.toBeNull()
      const className = chevron?.getAttribute('class') ?? ''
      // Both the bumped base opacity and the hover-reveal must be pinned so a
      // later refactor can't silently revert the discoverability fix. jsdom
      // does not exercise :hover state — we only assert the class is present.
      expect(className).toContain('opacity-70')
      expect(className).toContain('group-hover:opacity-100')
      // size-3 is deliberately preserved per the REVIEW-LATER entry.
      expect(className).toContain('size-3')

      // Sanity: the tablist-container-scoped query returns exactly one chevron
      // (only the active tab renders it).
      expect(container.querySelectorAll('svg.lucide-chevron-down')).toHaveLength(1)
    })

    it('the active tab (in page-editor view) has the `group` class so group-hover on the chevron resolves', () => {
      setupActiveInEditor()
      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      // Active tab must carry `group` — without it the chevron's
      // `group-hover:` utility is a no-op.
      expect(tabs[0]).toHaveClass('group')
    })
  })

  // ---------------------------------------------------------------------------
  // UX-255 active-tab dropdown trigger aria-label
  // ---------------------------------------------------------------------------
  describe('UX-255 active-tab dropdown trigger aria-label', () => {
    it('active tab in page-editor view has aria-label hinting the tab switcher', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const activeTab = tabs[1] as HTMLElement
      expect(activeTab.getAttribute('aria-label')).toBe(
        t('tabs.switchTabsHint', { title: 'Page 2' }),
      )
    })

    it('active tab aria-label falls back to "Untitled" title for empty labels', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [], label: '' },
          { id: '1', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const activeTab = tabs[0] as HTMLElement
      expect(activeTab.getAttribute('aria-label')).toBe(
        t('tabs.switchTabsHint', { title: t('tabs.untitled') }),
      )
    })

    it('inactive tabs do not set aria-label (accessible name falls back to visible text)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const inactiveTab = tabs[0] as HTMLElement
      expect(inactiveTab.getAttribute('aria-label')).toBeNull()
    })

    it('active tab in a non-editor view (journal) does not set aria-label', () => {
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const activeTab = tabs[0] as HTMLElement
      // No Popover wiring in non-editor views → no aria-label either.
      expect(activeTab.getAttribute('aria-label')).toBeNull()
    })

    it('Radix aria-haspopup and aria-expanded are preserved on the active tab in page-editor', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })

      render(<TabBar />)

      const tabs = screen.getAllByRole('tab')
      const activeTab = tabs[0] as HTMLElement
      expect(activeTab).toHaveAttribute('aria-haspopup', 'menu')
      expect(activeTab).toHaveAttribute('aria-expanded', 'false')
    })
  })
})

/**
 * Waits for the popover menu to disappear. Radix unmounts the portal via a
 * post-close effect so `queryByRole` can flicker — this helper polls.
 */
async function waitForMenuClosed(): Promise<void> {
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull()
  })
}
