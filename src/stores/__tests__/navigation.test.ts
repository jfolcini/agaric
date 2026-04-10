import { beforeEach, describe, expect, it } from 'vitest'
import { resetTabIdCounter, useNavigationStore } from '../navigation'

/** Helper to reset the store to a clean initial state. */
function resetStore() {
  resetTabIdCounter()
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    pageStack: [],
    selectedBlockId: null,
  })
}

describe('useNavigationStore', () => {
  beforeEach(() => {
    resetStore()
  })

  // ---------------------------------------------------------------------------
  // initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('defaults to journal view with empty stack and null selection', () => {
      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('journal')
      expect(state.pageStack).toEqual([])
      expect(state.selectedBlockId).toBeNull()
    })

    it('has a single empty tab at index 0', () => {
      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabIndex).toBe(0)
      expect(state.tabs[0]?.pageStack).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // setView
  // ---------------------------------------------------------------------------
  describe('setView', () => {
    it('switches the current view', () => {
      useNavigationStore.getState().setView('search')
      expect(useNavigationStore.getState().currentView).toBe('search')
    })

    it('clears pageStack and tabs when switching away from page-editor', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        pageStack: [{ pageId: 'P1', title: 'Page 1' }],
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(state.pageStack).toEqual([])
      expect(state.selectedBlockId).toBeNull()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.pageStack).toEqual([])
    })

    it('does not clear pageStack when switching between non-editor views', () => {
      // Manually set a stack (unlikely scenario, but guards the condition)
      useNavigationStore.setState({
        currentView: 'search',
        pageStack: [{ pageId: 'P1', title: 'Page 1' }],
      })

      useNavigationStore.getState().setView('tags')

      expect(useNavigationStore.getState().currentView).toBe('tags')
      expect(useNavigationStore.getState().pageStack).toHaveLength(1)
    })

    it('allows switching to page-editor directly', () => {
      useNavigationStore.getState().setView('page-editor')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // navigateToPage
  // ---------------------------------------------------------------------------
  describe('navigateToPage', () => {
    it('pushes page onto the stack and sets view to page-editor', () => {
      useNavigationStore.getState().navigateToPage('P1', 'My Page')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
      expect(state.selectedBlockId).toBeNull()
    })

    it('sets selectedBlockId when blockId is provided', () => {
      useNavigationStore.getState().navigateToPage('P1', 'My Page', 'BLOCK_42')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(state.selectedBlockId).toBe('BLOCK_42')
    })

    it('clears previous selectedBlockId when navigating without blockId', () => {
      useNavigationStore.setState({ selectedBlockId: 'OLD_BLOCK' })

      useNavigationStore.getState().navigateToPage('P1', 'Page')

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })

    it('builds up the stack with multiple navigations', () => {
      const { navigateToPage } = useNavigationStore.getState()

      navigateToPage('P1', 'Page 1')
      navigateToPage('P2', 'Page 2')
      navigateToPage('P3', 'Page 3')

      const state = useNavigationStore.getState()
      expect(state.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])
      expect(state.currentView).toBe('page-editor')
    })

    it('navigating to the same page updates selectedBlockId without pushing', () => {
      const { navigateToPage } = useNavigationStore.getState()

      navigateToPage('P1', 'Page 1')
      expect(useNavigationStore.getState().pageStack).toHaveLength(1)

      navigateToPage('P1', 'Page 1', 'BLOCK_X')

      const state = useNavigationStore.getState()
      expect(state.pageStack).toHaveLength(1)
      expect(state.selectedBlockId).toBe('BLOCK_X')
    })

    it('updates the active tab label to the top page title', () => {
      useNavigationStore.getState().navigateToPage('P1', 'My Page')

      const state = useNavigationStore.getState()
      expect(state.tabs[state.activeTabIndex]?.label).toBe('My Page')
    })
  })

  // ---------------------------------------------------------------------------
  // goBack
  // ---------------------------------------------------------------------------
  describe('goBack', () => {
    it('pops the last page from the stack', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          {
            id: '0',
            pageStack: [
              { pageId: 'P1', title: 'Page 1' },
              { pageId: 'P2', title: 'Page 2' },
            ],
            label: 'Page 2',
          },
        ],
        activeTabIndex: 0,
        pageStack: [
          { pageId: 'P1', title: 'Page 1' },
          { pageId: 'P2', title: 'Page 2' },
        ],
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('switches to pages view when stack becomes empty (last tab)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        pageStack: [{ pageId: 'P1', title: 'Page 1' }],
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(state.pageStack).toEqual([])
      expect(state.currentView).toBe('pages')
      expect(state.selectedBlockId).toBeNull()
    })

    it('is a no-op when stack is already empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        pageStack: [],
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(state.pageStack).toEqual([])
    })

    it('clears selectedBlockId when going back', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          {
            id: '0',
            pageStack: [
              { pageId: 'P1', title: 'Page 1' },
              { pageId: 'P2', title: 'Page 2' },
            ],
            label: 'Page 2',
          },
        ],
        activeTabIndex: 0,
        pageStack: [
          { pageId: 'P1', title: 'Page 1' },
          { pageId: 'P2', title: 'Page 2' },
        ],
        selectedBlockId: 'BLOCK_X',
      })

      useNavigationStore.getState().goBack()

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // replacePage
  // ---------------------------------------------------------------------------
  describe('replacePage', () => {
    it('replaces the top of the stack', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [
          {
            id: '0',
            pageStack: [
              { pageId: 'P1', title: 'Page 1' },
              { pageId: 'P2', title: 'Old Title' },
            ],
            label: 'Old Title',
          },
        ],
        activeTabIndex: 0,
        pageStack: [
          { pageId: 'P1', title: 'Page 1' },
          { pageId: 'P2', title: 'Old Title' },
        ],
      })

      useNavigationStore.getState().replacePage('P2', 'New Title')

      const state = useNavigationStore.getState()
      expect(state.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'New Title' },
      ])
      expect(state.tabs[0]?.label).toBe('New Title')
    })

    it('can replace both pageId and title', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'OLD_ID', title: 'Old' }], label: 'Old' }],
        activeTabIndex: 0,
        pageStack: [{ pageId: 'OLD_ID', title: 'Old' }],
      })

      useNavigationStore.getState().replacePage('NEW_ID', 'New')

      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'NEW_ID', title: 'New' }])
    })

    it('is a no-op when stack is empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        pageStack: [],
      })

      useNavigationStore.getState().replacePage('P1', 'Title')

      expect(useNavigationStore.getState().pageStack).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // clearSelection
  // ---------------------------------------------------------------------------
  describe('clearSelection', () => {
    it('resets selectedBlockId to null', () => {
      useNavigationStore.setState({ selectedBlockId: 'BLOCK_42' })

      useNavigationStore.getState().clearSelection()

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })

    it('is a no-op when selectedBlockId is already null', () => {
      useNavigationStore.setState({ selectedBlockId: null })

      useNavigationStore.getState().clearSelection()

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // openInNewTab
  // ---------------------------------------------------------------------------
  describe('openInNewTab', () => {
    it('creates a new tab with the given page and switches to it', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().openInNewTab('P2', 'Page 2')

      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabIndex).toBe(1)
      expect(state.pageStack).toEqual([{ pageId: 'P2', title: 'Page 2' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('sets the new tab label to the page title', () => {
      useNavigationStore.getState().openInNewTab('P1', 'My Page')

      const state = useNavigationStore.getState()
      expect(state.tabs[state.activeTabIndex]?.label).toBe('My Page')
    })

    it('preserves the previous tab stack', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().navigateToPage('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')

      const state = useNavigationStore.getState()
      expect(state.tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
      ])
      expect(state.tabs[1]?.pageStack).toEqual([{ pageId: 'P3', title: 'Page 3' }])
    })

    it('switches view to page-editor even from another view', () => {
      useNavigationStore.getState().setView('journal')
      useNavigationStore.getState().openInNewTab('P1', 'Page 1')

      expect(useNavigationStore.getState().currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // closeTab
  // ---------------------------------------------------------------------------
  describe('closeTab', () => {
    it('removes the specified tab and switches to adjacent', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')

      // Close middle tab (tab 1)
      useNavigationStore.getState().closeTab(1)

      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(2)
      expect(state.tabs[0]?.label).toBe('Page 1')
      expect(state.tabs[1]?.label).toBe('Page 3')
    })

    it('switches to pages view when closing the last tab', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().closeTab(0)

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(state.tabs).toHaveLength(1)
      expect(state.pageStack).toEqual([])
    })

    it('adjusts activeTabIndex when closing a tab before the active one', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')
      // Active is now tab 2 (P3)

      useNavigationStore.getState().closeTab(0)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(1)
      expect(state.pageStack).toEqual([{ pageId: 'P3', title: 'Page 3' }])
    })

    it('adjusts activeTabIndex when closing the active tab at the end', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      // Active is tab 1

      useNavigationStore.getState().closeTab(1)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('is a no-op for out-of-bounds index', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().closeTab(5)

      expect(useNavigationStore.getState().tabs).toHaveLength(1)
    })

    it('is a no-op for negative index', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().closeTab(-1)

      expect(useNavigationStore.getState().tabs).toHaveLength(1)
    })

    it('keeps activeTabIndex unchanged when closing a tab after the active one', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().switchTab(0)
      // Active is tab 0

      useNavigationStore.getState().closeTab(1)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })
  })

  // ---------------------------------------------------------------------------
  // switchTab
  // ---------------------------------------------------------------------------
  describe('switchTab', () => {
    it('switches to the specified tab', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      // Active is tab 1

      useNavigationStore.getState().switchTab(0)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('is a no-op when switching to the already active tab', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')

      const before = useNavigationStore.getState()
      useNavigationStore.getState().switchTab(1)
      const after = useNavigationStore.getState()

      expect(before.activeTabIndex).toBe(after.activeTabIndex)
    })

    it('is a no-op for out-of-bounds index', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().switchTab(5)

      expect(useNavigationStore.getState().activeTabIndex).toBe(0)
    })

    it('is a no-op for negative index', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')

      useNavigationStore.getState().switchTab(-1)

      expect(useNavigationStore.getState().activeTabIndex).toBe(0)
    })

    it('clears selectedBlockId when switching tabs', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1', 'BLOCK_1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.setState({ selectedBlockId: 'BLOCK_2' })

      useNavigationStore.getState().switchTab(0)

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // integration: multi-step navigation flows
  // ---------------------------------------------------------------------------
  describe('navigation flows', () => {
    it('navigate → navigate → goBack → goBack returns to pages', () => {
      const store = useNavigationStore.getState()

      store.navigateToPage('P1', 'Page 1')
      store.navigateToPage('P2', 'Page 2')

      expect(useNavigationStore.getState().pageStack).toHaveLength(2)

      useNavigationStore.getState().goBack()
      expect(useNavigationStore.getState().pageStack).toHaveLength(1)
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      useNavigationStore.getState().goBack()
      expect(useNavigationStore.getState().pageStack).toHaveLength(0)
      expect(useNavigationStore.getState().currentView).toBe('pages')
    })

    it('goBack on empty stack after returning to pages is a no-op', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
        pageStack: [],
      })

      useNavigationStore.getState().goBack()
      useNavigationStore.getState().goBack()

      expect(useNavigationStore.getState().currentView).toBe('pages')
      expect(useNavigationStore.getState().pageStack).toEqual([])
    })

    it('setView to non-editor clears stack, then navigate rebuilds it', () => {
      const store = useNavigationStore.getState()

      store.navigateToPage('P1', 'Page 1')
      store.navigateToPage('P2', 'Page 2')

      useNavigationStore.getState().setView('journal')
      expect(useNavigationStore.getState().pageStack).toEqual([])

      useNavigationStore.getState().navigateToPage('P3', 'Page 3')
      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'P3', title: 'Page 3' }])
    })
  })

  // ---------------------------------------------------------------------------
  // integration: multi-tab navigation flows
  // ---------------------------------------------------------------------------
  describe('multi-tab flows', () => {
    it('open multiple tabs then navigate within each independently', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')

      // Navigate within tab 1 (active)
      useNavigationStore.getState().navigateToPage('P3', 'Page 3')

      expect(useNavigationStore.getState().tabs[1]?.pageStack).toEqual([
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])

      // Switch to tab 0
      useNavigationStore.getState().switchTab(0)
      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])

      // Navigate within tab 0
      useNavigationStore.getState().navigateToPage('P4', 'Page 4')
      expect(useNavigationStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P4', title: 'Page 4' },
      ])
    })

    it('goBack with multiple tabs closes current empty tab instead of switching view', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')

      // goBack on tab 1 (P2 is only entry)
      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      // Should have closed tab 1 and switched to tab 0
      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabIndex).toBe(0)
      expect(state.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('pageStack always reflects the active tab', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')

      // Active is tab 2 (P3)
      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'P3', title: 'Page 3' }])

      useNavigationStore.getState().switchTab(0)
      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])

      useNavigationStore.getState().switchTab(1)
      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'P2', title: 'Page 2' }])
    })
  })
})
