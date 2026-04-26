import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalStore } from '../journal'
import {
  resetTabIdCounter,
  selectActiveTabIndexForSpace,
  selectPageStack,
  selectTabsForSpace,
  useNavigationStore,
} from '../navigation'
import { useRecentPagesStore } from '../recent-pages'
import { useSpaceStore } from '../space'

/** Helper to reset the store to a clean initial state. */
function resetStore() {
  resetTabIdCounter()
  // FEAT-3 Phase 3 — clear the per-space slices alongside the flat fields
  // so tab data from a prior test doesn't leak in via the selector fall-
  // back path.
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
    selectedBlockId: null,
  })
  // Reset journal store so date-routing tests start from a known baseline.
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(2026, 0, 1),
    scrollToDate: null,
    scrollToPanel: null,
  })
  // Reset recent-pages store so FEAT-9 hook tests start from an empty MRU.
  useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
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
      expect(selectPageStack(state)).toEqual([])
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

    it('preserves pageStack and tabs when switching away from page-editor (UX-251)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.selectedBlockId).toBe('B1')
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('does not clear pageStack when switching between non-editor views', () => {
      // Manually set a stack (unlikely scenario, but guards the condition)
      useNavigationStore.setState({
        currentView: 'search',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().setView('tags')

      expect(useNavigationStore.getState().currentView).toBe('tags')
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(1)
    })

    it('allows switching to page-editor directly', () => {
      useNavigationStore.getState().setView('page-editor')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
    })

    it('preserves tabs across every non-editor view destination (UX-251)', () => {
      const seededTabs = [
        {
          id: '0',
          pageStack: [{ pageId: 'P1', title: 'Page 1' }],
          label: 'Page 1',
        },
        {
          id: '1',
          pageStack: [
            { pageId: 'P2', title: 'Page 2' },
            { pageId: 'P3', title: 'Page 3' },
          ],
          label: 'Page 3',
        },
        {
          id: '2',
          pageStack: [{ pageId: 'P4', title: 'Page 4' }],
          label: 'Page 4',
        },
      ]

      const destinations = [
        'journal',
        'search',
        'pages',
        'tags',
        'properties',
        'trash',
        'status',
        'conflicts',
        'history',
        'templates',
        'settings',
        'graph',
      ] as const

      for (const view of destinations) {
        useNavigationStore.setState({
          currentView: 'page-editor',
          tabs: seededTabs.map((t) => ({ ...t, pageStack: [...t.pageStack] })),
          activeTabIndex: 1,
          selectedBlockId: null,
        })

        useNavigationStore.getState().setView(view)

        const state = useNavigationStore.getState()
        expect(state.currentView).toBe(view)
        expect(state.tabs).toHaveLength(3)
        expect(state.activeTabIndex).toBe(1)
        for (let i = 0; i < seededTabs.length; i++) {
          expect(state.tabs[i]?.pageStack).toEqual(seededTabs[i]?.pageStack)
        }
      }
    })

    it('round-trip setView(journal) -> setView(page-editor) preserves tabs identically (UX-251)', () => {
      const seededTabs = [
        {
          id: '0',
          pageStack: [{ pageId: 'P1', title: 'Page 1' }],
          label: 'Page 1',
        },
        {
          id: '1',
          pageStack: [
            { pageId: 'P2', title: 'Page 2' },
            { pageId: 'P3', title: 'Page 3' },
          ],
          label: 'Page 3',
        },
        {
          id: '2',
          pageStack: [{ pageId: 'P4', title: 'Page 4' }],
          label: 'Page 4',
        },
      ]

      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: seededTabs.map((t) => ({ ...t, pageStack: [...t.pageStack] })),
        activeTabIndex: 1,
        selectedBlockId: null,
      })

      useNavigationStore.getState().setView('journal')
      useNavigationStore.getState().setView('page-editor')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(state.activeTabIndex).toBe(1)
      expect(state.tabs).toEqual(seededTabs)
    })

    // UX-251: pins that `setView` honours its JSDoc contract at line 56 of
    // src/stores/navigation.ts — "DON'T clear tabs when leaving page-editor
    // (preserve them)".
    it('setView_preserves_tabs_when_leaving_page_editor_matching_jsdoc_contract', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.selectedBlockId).toBe('B1')
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
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
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'My Page' }])
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
      expect(selectPageStack(state)).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])
      expect(state.currentView).toBe('page-editor')
    })

    it('navigating to the same page updates selectedBlockId without pushing', () => {
      const { navigateToPage } = useNavigationStore.getState()

      navigateToPage('P1', 'Page 1')
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(1)

      navigateToPage('P1', 'Page 1', 'BLOCK_X')

      const state = useNavigationStore.getState()
      expect(selectPageStack(state)).toHaveLength(1)
      expect(state.selectedBlockId).toBe('BLOCK_X')
    })

    it('navigating to the page already at the top of the stack flips currentView back to page-editor', () => {
      const { navigateToPage, setView } = useNavigationStore.getState()

      // Open Page 1 → user is on the editor.
      navigateToPage('P1', 'Page 1')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      // User clicks the "Pages" sidebar button. The active tab still has
      // P1 at the top of its stack, but currentView is now 'pages'.
      setView('pages')
      expect(useNavigationStore.getState().currentView).toBe('pages')

      // Clicking the same page in the browser must bring the user back to
      // the page editor — otherwise the click looks like a no-op.
      navigateToPage('P1', 'Page 1')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(state)).toHaveLength(1)
    })

    it('updates the active tab label to the top page title', () => {
      useNavigationStore.getState().navigateToPage('P1', 'My Page')

      const state = useNavigationStore.getState()
      expect(state.tabs[state.activeTabIndex]?.label).toBe('My Page')
    })

    // ---------------------------------------------------------------------
    // UX-242: date-titled pages route to Journal → Daily instead of editor
    // ---------------------------------------------------------------------
    it('navigateToPage with YYYY-MM-DD title routes to journal daily', () => {
      useNavigationStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      const navState = useNavigationStore.getState()
      const journalState = useJournalStore.getState()

      expect(navState.currentView).toBe('journal')
      expect(journalState.mode).toBe('daily')
      expect(journalState.currentDate.getFullYear()).toBe(2026)
      expect(journalState.currentDate.getMonth()).toBe(3) // April = 3 (0-based)
      expect(journalState.currentDate.getDate()).toBe(20)
    })

    it('navigateToPage with YYYY-MM-DD title does NOT push onto pageStack', () => {
      useNavigationStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      const state = useNavigationStore.getState()
      expect(selectPageStack(state)).toEqual([])
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]?.pageStack).toEqual([])
    })

    it('navigateToPage with invalid date-shaped title (2026-13-45) falls back to page-editor', () => {
      useNavigationStore.getState().navigateToPage('PX', '2026-13-45')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(state)).toEqual([{ pageId: 'PX', title: '2026-13-45' }])
    })

    it('navigateToPage with blockId on a date-titled page preserves selectedBlockId', () => {
      useNavigationStore.getState().navigateToPage('DATE_PAGE', '2026-04-20', 'BLOCK_42')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('journal')
      expect(state.selectedBlockId).toBe('BLOCK_42')
    })

    it('navigateToPage with non-date title preserves existing page-editor behaviour', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Not A Date')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Not A Date' }])
      // Journal store should remain untouched from its test-reset baseline.
      const journalState = useJournalStore.getState()
      expect(journalState.currentDate.getFullYear()).toBe(2026)
      expect(journalState.currentDate.getMonth()).toBe(0)
      expect(journalState.currentDate.getDate()).toBe(1)
    })

    it('navigateToPage to a date title from page-editor preserves tabs and pageStack (UX-251)', () => {
      // Start on a regular page so we're in page-editor with a populated stack.
      useNavigationStore.getState().navigateToPage('P1', 'Regular Page')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(1)

      useNavigationStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('journal')
      expect(state.tabs).toHaveLength(1)
      expect(selectPageStack(state)).toHaveLength(1)
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Regular Page' }])
      expect(state.activeTabIndex).toBe(0)
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
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('switches to pages view when stack becomes empty (last tab)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(selectPageStack(state)).toEqual([])
      expect(state.currentView).toBe('pages')
      expect(state.selectedBlockId).toBeNull()
    })

    it('is a no-op when stack is already empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(state)).toEqual([])
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
      })

      useNavigationStore.getState().replacePage('P2', 'New Title')

      const state = useNavigationStore.getState()
      expect(selectPageStack(state)).toEqual([
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
      })

      useNavigationStore.getState().replacePage('NEW_ID', 'New')

      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'NEW_ID', title: 'New' },
      ])
    })

    it('is a no-op when stack is empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().replacePage('P1', 'Title')

      expect(selectPageStack(useNavigationStore.getState())).toEqual([])
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
      expect(selectPageStack(state)).toEqual([{ pageId: 'P2', title: 'Page 2' }])
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
      expect(selectPageStack(state)).toEqual([])
    })

    it('adjusts activeTabIndex when closing a tab before the active one', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')
      // Active is now tab 2 (P3)

      useNavigationStore.getState().closeTab(0)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(1)
      expect(selectPageStack(state)).toEqual([{ pageId: 'P3', title: 'Page 3' }])
    })

    it('adjusts activeTabIndex when closing the active tab at the end', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      // Active is tab 1

      useNavigationStore.getState().closeTab(1)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
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
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
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
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
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

    // FEAT-7 scope item 3: TabBar is hoisted to the app shell so a click on
    // any tab from a non-editor view must also flip `currentView` back to
    // 'page-editor' — otherwise the user clicks a tab and nothing visible
    // changes because the editor is not rendered.
    it('FEAT-7: switching tabs from a non-editor view flips currentView to page-editor', () => {
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
        ],
        activeTabIndex: 0,
        selectedBlockId: null,
      })

      useNavigationStore.getState().switchTab(2)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(2)
      expect(state.currentView).toBe('page-editor')
    })

    it('FEAT-7: switching tabs from page-editor leaves currentView unchanged', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      useNavigationStore.getState().switchTab(0)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(0)
      expect(state.currentView).toBe('page-editor')
    })

    // FEAT-7: clicking the already-active tab while on a non-editor view is
    // NOT a no-op — it should flip back to the editor. (The pure "active
    // tab in editor" no-op branch is still covered above.)
    it('FEAT-7: clicking the active tab from a non-editor view flips currentView to page-editor', () => {
      useNavigationStore.setState({
        currentView: 'journal',
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
        selectedBlockId: null,
      })

      useNavigationStore.getState().switchTab(1)

      const state = useNavigationStore.getState()
      expect(state.activeTabIndex).toBe(1)
      expect(state.currentView).toBe('page-editor')
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

      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(2)

      useNavigationStore.getState().goBack()
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(1)
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      useNavigationStore.getState().goBack()
      expect(selectPageStack(useNavigationStore.getState())).toHaveLength(0)
      expect(useNavigationStore.getState().currentView).toBe('pages')
    })

    it('goBack on empty stack after returning to pages is a no-op', () => {
      useNavigationStore.setState({
        currentView: 'pages',
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().goBack()
      useNavigationStore.getState().goBack()

      expect(useNavigationStore.getState().currentView).toBe('pages')
      expect(selectPageStack(useNavigationStore.getState())).toEqual([])
    })

    it('setView to non-editor preserves stack; navigate appends onto it (UX-251)', () => {
      const store = useNavigationStore.getState()

      store.navigateToPage('P1', 'Page 1')
      store.navigateToPage('P2', 'Page 2')

      useNavigationStore.getState().setView('journal')
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
      ])

      useNavigationStore.getState().navigateToPage('P3', 'Page 3')
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])
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
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
      ])

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
      expect(selectPageStack(state)).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('pageStack always reflects the active tab', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')

      // Active is tab 2 (P3)
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P3', title: 'Page 3' },
      ])

      useNavigationStore.getState().switchTab(0)
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
      ])

      useNavigationStore.getState().switchTab(1)
      expect(selectPageStack(useNavigationStore.getState())).toEqual([
        { pageId: 'P2', title: 'Page 2' },
      ])
    })
  })

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  describe('persistence', () => {
    const STORAGE_KEY = 'agaric:navigation'

    beforeEach(() => {
      resetStore()
      localStorage.removeItem(STORAGE_KEY)
    })

    it('persists tabs and currentView to localStorage', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1')
      useNavigationStore.getState().openInNewTab('P2', 'Page 2')

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(1)
      expect(parsed.state.currentView).toBe('page-editor')
      expect(parsed.state.tabs).toHaveLength(2)
      expect(parsed.state.activeTabIndex).toBe(1)
    })

    it('restores tabs from localStorage on re-create', () => {
      const persistedState = {
        state: {
          currentView: 'page-editor',
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
        },
        version: 0,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState))

      // Trigger rehydration
      useNavigationStore.persist.rehydrate()

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabIndex).toBe(1)
      expect(state.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.tabs[1]?.pageStack).toEqual([{ pageId: 'P2', title: 'Page 2' }])
    })

    it('does not persist selectedBlockId', () => {
      useNavigationStore.getState().navigateToPage('P1', 'Page 1', 'BLOCK_42')

      // Verify it's in memory
      expect(useNavigationStore.getState().selectedBlockId).toBe('BLOCK_42')

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.state).not.toHaveProperty('selectedBlockId')
    })

    it('gracefully handles corrupted localStorage', () => {
      localStorage.setItem(STORAGE_KEY, '!!!not-valid-json{{{')

      // Rehydrate should not throw; store falls back to defaults
      expect(() => useNavigationStore.persist.rehydrate()).not.toThrow()

      const state = useNavigationStore.getState()
      // Store should still be functional with its current state
      expect(state.currentView).toBeDefined()
      expect(state.tabs).toBeDefined()
    })

    it('derives nextTabId from persisted tabs to avoid ID collisions', () => {
      const persistedState = {
        state: {
          currentView: 'page-editor',
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '5', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
        },
        version: 0,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState))

      useNavigationStore.persist.rehydrate()

      // After rehydrating tabs with max ID '5', new tabs should get ID '6'+
      useNavigationStore.getState().openInNewTab('P3', 'Page 3')

      const state = useNavigationStore.getState()
      expect(state.tabs).toHaveLength(3)
      const newTabId = Number.parseInt(state.tabs[2]?.id ?? '0', 10)
      expect(newTabId).toBeGreaterThanOrEqual(6)
    })
  })

  // ---------------------------------------------------------------------------
  // FEAT-9: navigateToPage → useRecentPagesStore.recordVisit integration
  // ---------------------------------------------------------------------------
  describe('FEAT-9 recentPages recordVisit hook', () => {
    beforeEach(() => {
      useRecentPagesStore.setState({ recentPages: [] })
    })

    it('navigateToPage calls recordVisit with pageId and title', () => {
      const recordVisitSpy = vi.spyOn(useRecentPagesStore.getState(), 'recordVisit')

      useNavigationStore.getState().navigateToPage('A', 'Alpha')

      expect(recordVisitSpy).toHaveBeenCalledTimes(1)
      expect(recordVisitSpy).toHaveBeenCalledWith({ pageId: 'A', title: 'Alpha' })

      recordVisitSpy.mockRestore()
    })

    it('setView does NOT call recordVisit', () => {
      const recordVisitSpy = vi.spyOn(useRecentPagesStore.getState(), 'recordVisit')

      useNavigationStore.getState().setView('journal')
      useNavigationStore.getState().setView('pages')
      useNavigationStore.getState().setView('tags')

      expect(recordVisitSpy).not.toHaveBeenCalled()

      recordVisitSpy.mockRestore()
    })

    it('goBack does NOT call recordVisit', () => {
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
      })

      const recordVisitSpy = vi.spyOn(useRecentPagesStore.getState(), 'recordVisit')

      useNavigationStore.getState().goBack()

      expect(recordVisitSpy).not.toHaveBeenCalled()

      recordVisitSpy.mockRestore()
    })

    it('date-routed branch still records the visit (date pages are page visits)', () => {
      const recordVisitSpy = vi.spyOn(useRecentPagesStore.getState(), 'recordVisit')

      useNavigationStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      expect(recordVisitSpy).toHaveBeenCalledTimes(1)
      expect(recordVisitSpy).toHaveBeenCalledWith({
        pageId: 'DATE_PAGE',
        title: '2026-04-20',
      })

      // Assert the store actually received the visit (not just that the spy
      // was called — belt and braces).
      const { recentPages } = useRecentPagesStore.getState()
      expect(recentPages).toHaveLength(1)
      expect(recentPages[0]).toEqual({ pageId: 'DATE_PAGE', title: '2026-04-20' })

      recordVisitSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // FEAT-3 Phase 3 — per-space tab partitioning
  // ---------------------------------------------------------------------------
  describe('FEAT-3p3 per-space tabs', () => {
    beforeEach(() => {
      // Each per-space test drives `useSpaceStore` directly. Reset it
      // back to "no active space" between cases so the subscriber never
      // races against leftovers from a sibling test.
      useSpaceStore.setState({ currentSpaceId: null, availableSpaces: [], isReady: true })
    })

    it('selectTabsForSpace falls back to flat state.tabs when spaceId is null', () => {
      useNavigationStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        tabsBySpace: {},
        activeTabIndexBySpace: {},
      })
      const state = useNavigationStore.getState()
      expect(selectTabsForSpace(state, null)).toEqual([
        { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
      ])
      expect(selectActiveTabIndexForSpace(state, null)).toBe(0)
    })

    it('selectTabsForSpace reads from per-space slice when spaceId is non-null', () => {
      useNavigationStore.setState({
        tabs: [],
        activeTabIndex: 0,
        tabsBySpace: {
          'space-1': [{ id: 'a', pageStack: [{ pageId: 'A', title: 'Alpha' }], label: 'Alpha' }],
          'space-2': [{ id: 'b', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' }],
        },
        activeTabIndexBySpace: { 'space-1': 0, 'space-2': 0 },
      })
      const state = useNavigationStore.getState()
      expect(selectTabsForSpace(state, 'space-1')).toEqual([
        { id: 'a', pageStack: [{ pageId: 'A', title: 'Alpha' }], label: 'Alpha' },
      ])
      expect(selectTabsForSpace(state, 'space-2')).toEqual([
        { id: 'b', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' },
      ])
    })

    it('openInNewTab in space-1 does not appear in tabsBySpace[space-2]', () => {
      // Activate space-1, then open a tab. The action writes to both
      // state.tabs (active mirror) AND tabsBySpace['space-1'].
      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [
          { id: 'space-1', name: 'One', accent_color: null },
          { id: 'space-2', name: 'Two', accent_color: null },
        ],
        isReady: true,
      })
      useNavigationStore.getState().openInNewTab('PAGE_A', 'Alpha')

      const state = useNavigationStore.getState()
      // Per-space slice for space-1 contains the new tab.
      expect(state.tabsBySpace['space-1']?.some((t) => t.label === 'Alpha')).toBe(true)
      // space-2 has no slice yet — the per-space partition holds.
      expect(state.tabsBySpace['space-2']).toBeUndefined()
      // Selector for space-2 returns the fall-back (active mirror), but the
      // raw partition map is what cross-space code paths read in production.
      expect(state.tabsBySpace['space-1']).not.toEqual(state.tabsBySpace['space-2'] ?? [])
    })

    it('switching space flushes the outgoing tabs and pulls the incoming slice', () => {
      // Seed space-1 with a tab via the action so the per-space slice
      // and the flat fields end up in sync.
      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [
          { id: 'space-1', name: 'One', accent_color: null },
          { id: 'space-2', name: 'Two', accent_color: null },
        ],
        isReady: true,
      })
      useNavigationStore.getState().openInNewTab('PAGE_A', 'Alpha')
      // Pre-seed space-2 so we can verify pull-on-switch.
      useNavigationStore.setState((prev) => ({
        tabsBySpace: {
          ...prev.tabsBySpace,
          'space-2': [{ id: 'b', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' }],
        },
        activeTabIndexBySpace: { ...prev.activeTabIndexBySpace, 'space-2': 0 },
      }))

      // Switch space-1 → space-2. The subscriber flushes flat (space-1's
      // current view) into tabsBySpace['space-1'] and pulls space-2's
      // slice into the flat fields.
      useSpaceStore.setState({ currentSpaceId: 'space-2' })

      const state = useNavigationStore.getState()
      expect(state.tabs.some((t) => t.label === 'Bravo')).toBe(true)
      // space-1's tab must still be retained in its slice.
      expect(state.tabsBySpace['space-1']?.some((t) => t.label === 'Alpha')).toBe(true)
    })

    it('rehydrate with stale currentSpaceId (no slice) does not crash', () => {
      // Persisted shape has tabsBySpace + activeTabIndexBySpace but the
      // user's current space is no longer a key. This is the
      // "deleted-on-another-device" path.
      const STORAGE_KEY = 'agaric:navigation'
      const persistedState = {
        state: {
          currentView: 'page-editor',
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
          tabsBySpace: {
            'space-1': [
              { id: '1', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            ],
          },
          activeTabIndexBySpace: { 'space-1': 0 },
        },
        version: 1,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState))
      useSpaceStore.setState({ currentSpaceId: 'space-DELETED' })

      expect(() => useNavigationStore.persist.rehydrate()).not.toThrow()

      const state = useNavigationStore.getState()
      // Selector for the now-stale current space falls back to the flat
      // mirror (a single empty tab) rather than throwing.
      const tabs = selectTabsForSpace(state, useSpaceStore.getState().currentSpaceId)
      expect(Array.isArray(tabs)).toBe(true)

      localStorage.removeItem(STORAGE_KEY)
    })

    it('persistence round-trips tabsBySpace + activeTabIndexBySpace', () => {
      const STORAGE_KEY = 'agaric:navigation'
      localStorage.removeItem(STORAGE_KEY)

      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [{ id: 'space-1', name: 'One', accent_color: null }],
        isReady: true,
      })
      useNavigationStore.getState().openInNewTab('PAGE_A', 'Alpha')
      useNavigationStore.getState().openInNewTab('PAGE_B', 'Bravo')

      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(1)
      expect(parsed.state.tabsBySpace['space-1']).toBeDefined()
      expect(parsed.state.tabsBySpace['space-1']).toHaveLength(3) // initial empty + 2 opens
      expect(parsed.state.activeTabIndexBySpace['space-1']).toBe(2)
    })

    it('migration from v0 (flat-only) seeds tabsBySpace.__legacy__', () => {
      const STORAGE_KEY = 'agaric:navigation'
      const legacyShape = {
        state: {
          currentView: 'page-editor',
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
        },
        version: 0,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyShape))
      useSpaceStore.setState({ currentSpaceId: null })

      useNavigationStore.persist.rehydrate()

      const state = useNavigationStore.getState()
      // The migration must move the legacy flat tabs into the __legacy__
      // slot so consumers that pass `currentSpaceId = null` (or fall
      // through via the per-space fall-back) keep seeing them.
      expect(state.tabsBySpace['__legacy__']).toBeDefined()
      expect(state.tabsBySpace['__legacy__']).toHaveLength(2)
      expect(state.activeTabIndexBySpace['__legacy__']).toBe(1)
      // The flat fields are still populated for the legacy reads.
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabIndex).toBe(1)

      localStorage.removeItem(STORAGE_KEY)
    })
  })
})
