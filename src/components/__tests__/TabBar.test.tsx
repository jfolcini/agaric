import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { resetTabIdCounter, selectPageStack, useNavigationStore } from '../../stores/navigation'
import { TabBar } from '../TabBar'

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
})
