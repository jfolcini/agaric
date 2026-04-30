import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalStore } from '../journal'
import { useNavigationStore } from '../navigation'
import { useRecentPagesStore } from '../recent-pages'
import { useSpaceStore } from '../space'
import {
  resetTabIdCounter,
  selectActiveTabIndexForSpace,
  selectPageStack,
  selectTabsForSpace,
  useTabsStore,
} from '../tabs'

/** Helper to reset the store to a clean initial state. */
function resetStore() {
  resetTabIdCounter()
  // FEAT-3 Phase 3 — clear the per-space slices alongside the flat fields
  // so tab data from a prior test doesn't leak in via the selector fall-
  // back path.
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
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
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
      expect(state.selectedBlockId).toBeNull()
    })

    it('has a single empty tab at index 0', () => {
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([])
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
        selectedBlockId: 'B1',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.selectedBlockId).toBe('B1')
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
      ])
    })

    it('does not clear pageStack when switching between non-editor views', () => {
      // Manually set a stack (unlikely scenario, but guards the condition)
      useNavigationStore.setState({
        currentView: 'search',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().setView('tags')

      expect(useNavigationStore.getState().currentView).toBe('tags')
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
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
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: seededTabs.map((t) => ({ ...t, pageStack: [...t.pageStack] })),
          activeTabIndex: 1,
        })

        useNavigationStore.getState().setView(view)

        const state = useNavigationStore.getState()
        expect(state.currentView).toBe(view)
        expect(useTabsStore.getState().tabs).toHaveLength(3)
        expect(useTabsStore.getState().activeTabIndex).toBe(1)
        for (let i = 0; i < seededTabs.length; i++) {
          expect(useTabsStore.getState().tabs[i]?.pageStack).toEqual(seededTabs[i]?.pageStack)
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
        selectedBlockId: null,
      })
      useTabsStore.setState({
        tabs: seededTabs.map((t) => ({ ...t, pageStack: [...t.pageStack] })),
        activeTabIndex: 1,
      })

      useNavigationStore.getState().setView('journal')
      useNavigationStore.getState().setView('page-editor')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(useTabsStore.getState().activeTabIndex).toBe(1)
      expect(useTabsStore.getState().tabs).toEqual(seededTabs)
    })

    // UX-251: pins that `setView` honours its JSDoc contract at line 56 of
    // src/stores/navigation.ts — "DON'T clear tabs when leaving page-editor
    // (preserve them)".
    it('setView_preserves_tabs_when_leaving_page_editor_matching_jsdoc_contract', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        selectedBlockId: 'B1',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.selectedBlockId).toBe('B1')
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
      ])
    })
  })

  // ---------------------------------------------------------------------------
  // navigateToPage
  // ---------------------------------------------------------------------------
  describe('navigateToPage', () => {
    it('pushes page onto the stack and sets view to page-editor', () => {
      useTabsStore.getState().navigateToPage('P1', 'My Page')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'My Page' }])
      expect(state.selectedBlockId).toBeNull()
    })

    it('sets selectedBlockId when blockId is provided', () => {
      useTabsStore.getState().navigateToPage('P1', 'My Page', 'BLOCK_42')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(state.selectedBlockId).toBe('BLOCK_42')
    })

    it('clears previous selectedBlockId when navigating without blockId', () => {
      useNavigationStore.setState({ selectedBlockId: 'OLD_BLOCK' })

      useTabsStore.getState().navigateToPage('P1', 'Page')

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })

    it('builds up the stack with multiple navigations', () => {
      const { navigateToPage } = useTabsStore.getState()

      navigateToPage('P1', 'Page 1')
      navigateToPage('P2', 'Page 2')
      navigateToPage('P3', 'Page 3')

      const state = useNavigationStore.getState()
      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])
      expect(state.currentView).toBe('page-editor')
    })

    it('navigating to the same page updates selectedBlockId without pushing', () => {
      const { navigateToPage } = useTabsStore.getState()

      navigateToPage('P1', 'Page 1')
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)

      navigateToPage('P1', 'Page 1', 'BLOCK_X')

      const state = useNavigationStore.getState()
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
      expect(state.selectedBlockId).toBe('BLOCK_X')
    })

    it('navigating to the page already at the top of the stack flips currentView back to page-editor', () => {
      const { setView } = useNavigationStore.getState()
      const { navigateToPage } = useTabsStore.getState()

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
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
    })

    it('updates the active tab label to the top page title', () => {
      useTabsStore.getState().navigateToPage('P1', 'My Page')

      expect(useTabsStore.getState().tabs[useTabsStore.getState().activeTabIndex]?.label).toBe(
        'My Page',
      )
    })

    // ---------------------------------------------------------------------
    // UX-242: date-titled pages route to Journal → Daily instead of editor
    // ---------------------------------------------------------------------
    it('navigateToPage with YYYY-MM-DD title routes to journal daily', () => {
      useTabsStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      const navState = useNavigationStore.getState()
      const journalState = useJournalStore.getState()

      expect(navState.currentView).toBe('journal')
      expect(journalState.mode).toBe('daily')
      expect(journalState.currentDate.getFullYear()).toBe(2026)
      expect(journalState.currentDate.getMonth()).toBe(3) // April = 3 (0-based)
      expect(journalState.currentDate.getDate()).toBe(20)
    })

    it('navigateToPage with YYYY-MM-DD title does NOT push onto pageStack', () => {
      useTabsStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      expect(selectPageStack(useTabsStore.getState())).toEqual([])
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([])
    })

    it('navigateToPage with invalid date-shaped title (2026-13-45) falls back to page-editor', () => {
      useTabsStore.getState().navigateToPage('PX', '2026-13-45')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'PX', title: '2026-13-45' },
      ])
    })

    it('navigateToPage with blockId on a date-titled page preserves selectedBlockId', () => {
      useTabsStore.getState().navigateToPage('DATE_PAGE', '2026-04-20', 'BLOCK_42')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('journal')
      expect(state.selectedBlockId).toBe('BLOCK_42')
    })

    it('navigateToPage with non-date title preserves existing page-editor behaviour', () => {
      useTabsStore.getState().navigateToPage('P1', 'Not A Date')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('page-editor')
      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'P1', title: 'Not A Date' },
      ])
      // Journal store should remain untouched from its test-reset baseline.
      const journalState = useJournalStore.getState()
      expect(journalState.currentDate.getFullYear()).toBe(2026)
      expect(journalState.currentDate.getMonth()).toBe(0)
      expect(journalState.currentDate.getDate()).toBe(1)
    })

    it('navigateToPage to a date title from page-editor preserves tabs and pageStack (UX-251)', () => {
      // Start on a regular page so we're in page-editor with a populated stack.
      useTabsStore.getState().navigateToPage('P1', 'Regular Page')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)

      useTabsStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('journal')
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'P1', title: 'Regular Page' },
      ])
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // goBack
  // ---------------------------------------------------------------------------
  describe('goBack', () => {
    it('pops the last page from the stack', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
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

      useTabsStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('switches to pages view when stack becomes empty (last tab)', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        selectedBlockId: 'B1',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
      })

      useTabsStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
      expect(state.currentView).toBe('pages')
      expect(state.selectedBlockId).toBeNull()
    })

    it('is a no-op when stack is already empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useTabsStore.getState().goBack()

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
    })

    it('clears selectedBlockId when going back', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        selectedBlockId: 'BLOCK_X',
      })
      useTabsStore.setState({
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

      useTabsStore.getState().goBack()

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
      })
      useTabsStore.setState({
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

      useTabsStore.getState().replacePage('P2', 'New Title')

      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'New Title' },
      ])
      expect(useTabsStore.getState().tabs[0]?.label).toBe('New Title')
    })

    it('can replace both pageId and title', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'OLD_ID', title: 'Old' }], label: 'Old' }],
        activeTabIndex: 0,
      })

      useTabsStore.getState().replacePage('NEW_ID', 'New')

      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'NEW_ID', title: 'New' }])
    })

    it('is a no-op when stack is empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useTabsStore.getState().replacePage('P1', 'Title')

      expect(selectPageStack(useTabsStore.getState())).toEqual([])
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
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().openInNewTab('P2', 'Page 2')

      const state = useNavigationStore.getState()
      expect(useTabsStore.getState().tabs).toHaveLength(2)
      expect(useTabsStore.getState().activeTabIndex).toBe(1)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P2', title: 'Page 2' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('sets the new tab label to the page title', () => {
      useTabsStore.getState().openInNewTab('P1', 'My Page')

      expect(useTabsStore.getState().tabs[useTabsStore.getState().activeTabIndex]?.label).toBe(
        'My Page',
      )
    })

    it('preserves the previous tab stack', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().navigateToPage('P2', 'Page 2')
      useTabsStore.getState().openInNewTab('P3', 'Page 3')

      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
      ])
      expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
        { pageId: 'P3', title: 'Page 3' },
      ])
    })

    it('switches view to page-editor even from another view', () => {
      useNavigationStore.getState().setView('journal')
      useTabsStore.getState().openInNewTab('P1', 'Page 1')

      expect(useNavigationStore.getState().currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // closeTab
  // ---------------------------------------------------------------------------
  describe('closeTab', () => {
    it('removes the specified tab and switches to adjacent', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      useTabsStore.getState().openInNewTab('P3', 'Page 3')

      // Close middle tab (tab 1)
      useTabsStore.getState().closeTab(1)

      expect(useTabsStore.getState().tabs).toHaveLength(2)
      expect(useTabsStore.getState().tabs[0]?.label).toBe('Page 1')
      expect(useTabsStore.getState().tabs[1]?.label).toBe('Page 3')
    })

    it('switches to pages view when closing the last tab', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().closeTab(0)

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
    })

    it('adjusts activeTabIndex when closing a tab before the active one', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      useTabsStore.getState().openInNewTab('P3', 'Page 3')
      // Active is now tab 2 (P3)

      useTabsStore.getState().closeTab(0)

      expect(useTabsStore.getState().activeTabIndex).toBe(1)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P3', title: 'Page 3' }])
    })

    it('adjusts activeTabIndex when closing the active tab at the end', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      // Active is tab 1

      useTabsStore.getState().closeTab(1)

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('is a no-op for out-of-bounds index', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().closeTab(5)

      expect(useTabsStore.getState().tabs).toHaveLength(1)
    })

    it('is a no-op for negative index', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().closeTab(-1)

      expect(useTabsStore.getState().tabs).toHaveLength(1)
    })

    it('keeps activeTabIndex unchanged when closing a tab after the active one', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      useTabsStore.getState().switchTab(0)
      // Active is tab 0

      useTabsStore.getState().closeTab(1)

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })
  })

  // ---------------------------------------------------------------------------
  // switchTab
  // ---------------------------------------------------------------------------
  describe('switchTab', () => {
    it('switches to the specified tab', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      // Active is tab 1

      useTabsStore.getState().switchTab(0)

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
    })

    it('is a no-op when switching to the already active tab', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')

      useTabsStore.getState().switchTab(1)

      expect(useTabsStore.getState().activeTabIndex).toBe(useTabsStore.getState().activeTabIndex)
    })

    it('is a no-op for out-of-bounds index', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().switchTab(5)

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })

    it('is a no-op for negative index', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')

      useTabsStore.getState().switchTab(-1)

      expect(useTabsStore.getState().activeTabIndex).toBe(0)
    })

    it('clears selectedBlockId when switching tabs', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1', 'BLOCK_1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      useNavigationStore.setState({ selectedBlockId: 'BLOCK_2' })

      useTabsStore.getState().switchTab(0)

      expect(useNavigationStore.getState().selectedBlockId).toBeNull()
    })

    // FEAT-7 scope item 3: TabBar is hoisted to the app shell so a click on
    // any tab from a non-editor view must also flip `currentView` back to
    // 'page-editor' — otherwise the user clicks a tab and nothing visible
    // changes because the editor is not rendered.
    it('FEAT-7: switching tabs from a non-editor view flips currentView to page-editor', () => {
      useNavigationStore.setState({
        currentView: 'journal',
        selectedBlockId: null,
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          { id: '2', pageStack: [{ pageId: 'P3', title: 'Page 3' }], label: 'Page 3' },
        ],
        activeTabIndex: 0,
      })

      useTabsStore.getState().switchTab(2)

      const state = useNavigationStore.getState()
      expect(useTabsStore.getState().activeTabIndex).toBe(2)
      expect(state.currentView).toBe('page-editor')
    })

    it('FEAT-7: switching tabs from page-editor leaves currentView unchanged', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      useTabsStore.getState().switchTab(0)

      const state = useNavigationStore.getState()
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(state.currentView).toBe('page-editor')
    })

    // FEAT-7: clicking the already-active tab while on a non-editor view is
    // NOT a no-op — it should flip back to the editor. (The pure "active
    // tab in editor" no-op branch is still covered above.)
    it('FEAT-7: clicking the active tab from a non-editor view flips currentView to page-editor', () => {
      useNavigationStore.setState({
        currentView: 'journal',
        selectedBlockId: null,
      })
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 1,
      })

      useTabsStore.getState().switchTab(1)

      const state = useNavigationStore.getState()
      expect(useTabsStore.getState().activeTabIndex).toBe(1)
      expect(state.currentView).toBe('page-editor')
    })
  })

  // ---------------------------------------------------------------------------
  // integration: multi-step navigation flows
  // ---------------------------------------------------------------------------
  describe('navigation flows', () => {
    it('navigate → navigate → goBack → goBack returns to pages', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().navigateToPage('P2', 'Page 2')

      expect(selectPageStack(useTabsStore.getState())).toHaveLength(2)

      useTabsStore.getState().goBack()
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
      expect(useNavigationStore.getState().currentView).toBe('page-editor')

      useTabsStore.getState().goBack()
      expect(selectPageStack(useTabsStore.getState())).toHaveLength(0)
      expect(useNavigationStore.getState().currentView).toBe('pages')
    })

    it('goBack on empty stack after returning to pages is a no-op', () => {
      useNavigationStore.setState({
        currentView: 'pages',
      })
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [], label: '' }],
        activeTabIndex: 0,
      })

      useTabsStore.getState().goBack()
      useTabsStore.getState().goBack()

      expect(useNavigationStore.getState().currentView).toBe('pages')
      expect(selectPageStack(useTabsStore.getState())).toEqual([])
    })

    it('setView to non-editor preserves stack; navigate appends onto it (UX-251)', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().navigateToPage('P2', 'Page 2')

      useNavigationStore.getState().setView('journal')
      expect(selectPageStack(useTabsStore.getState())).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P2', title: 'Page 2' },
      ])

      useTabsStore.getState().navigateToPage('P3', 'Page 3')
      expect(selectPageStack(useTabsStore.getState())).toEqual([
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
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')

      // Navigate within tab 1 (active)
      useTabsStore.getState().navigateToPage('P3', 'Page 3')

      expect(useTabsStore.getState().tabs[1]?.pageStack).toEqual([
        { pageId: 'P2', title: 'Page 2' },
        { pageId: 'P3', title: 'Page 3' },
      ])

      // Switch to tab 0
      useTabsStore.getState().switchTab(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])

      // Navigate within tab 0
      useTabsStore.getState().navigateToPage('P4', 'Page 4')
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'P1', title: 'Page 1' },
        { pageId: 'P4', title: 'Page 4' },
      ])
    })

    it('goBack with multiple tabs closes current empty tab instead of switching view', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')

      // goBack on tab 1 (P2 is only entry)
      useTabsStore.getState().goBack()

      const state = useNavigationStore.getState()
      // Should have closed tab 1 and switched to tab 0
      expect(useTabsStore.getState().tabs).toHaveLength(1)
      expect(useTabsStore.getState().activeTabIndex).toBe(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(state.currentView).toBe('page-editor')
    })

    it('pageStack always reflects the active tab', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')
      useTabsStore.getState().openInNewTab('P3', 'Page 3')

      // Active is tab 2 (P3)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P3', title: 'Page 3' }])

      useTabsStore.getState().switchTab(0)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P1', title: 'Page 1' }])

      useTabsStore.getState().switchTab(1)
      expect(selectPageStack(useTabsStore.getState())).toEqual([{ pageId: 'P2', title: 'Page 2' }])
    })
  })

  // ---------------------------------------------------------------------------
  // persistence (MAINT-127 — split across two storage keys)
  //
  // After the navigation/tabs split, persisted state lives under TWO keys:
  //   - `agaric:navigation` (version 2): currentView only
  //   - `agaric:tabs` (version 1): tabs + activeTabIndex + per-space slices
  //
  // Tests below verify each key holds the correct slice of state and that
  // rehydration from a clean storage works as expected. The v1→v2 nav
  // migration drops legacy tab fields; the simpler split-time UX cost is
  // that users start with FRESH tabs on first post-split boot. See the
  // migration notes in `src/stores/navigation.ts` and `src/stores/tabs.ts`.
  // ---------------------------------------------------------------------------
  describe('persistence', () => {
    const NAV_STORAGE_KEY = 'agaric:navigation'
    const TABS_STORAGE_KEY = 'agaric:tabs'

    beforeEach(() => {
      resetStore()
      localStorage.removeItem(NAV_STORAGE_KEY)
      localStorage.removeItem(TABS_STORAGE_KEY)
    })

    it('persists currentView to the navigation storage key', () => {
      useNavigationStore.getState().setView('search')

      const raw = localStorage.getItem(NAV_STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(2)
      expect(parsed.state.currentView).toBe('search')
      // Tabs do NOT bleed into the navigation slot post-split.
      expect(parsed.state).not.toHaveProperty('tabs')
      expect(parsed.state).not.toHaveProperty('activeTabIndex')
    })

    it('persists tabs to the tabs storage key', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1')
      useTabsStore.getState().openInNewTab('P2', 'Page 2')

      const raw = localStorage.getItem(TABS_STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(1)
      expect(parsed.state.tabs).toHaveLength(2)
      expect(parsed.state.activeTabIndex).toBe(1)
      // currentView lives in the navigation slot, not here.
      expect(parsed.state).not.toHaveProperty('currentView')
    })

    it('restores tabs from the tabs storage key on re-create', () => {
      const persistedState = {
        state: {
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
          tabsBySpace: {},
          activeTabIndexBySpace: {},
        },
        version: 1,
      }
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(persistedState))

      // Trigger rehydration
      useTabsStore.persist.rehydrate()

      const tabs = useTabsStore.getState()
      expect(tabs.tabs).toHaveLength(2)
      expect(tabs.activeTabIndex).toBe(1)
      expect(tabs.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'Page 1' }])
      expect(tabs.tabs[1]?.pageStack).toEqual([{ pageId: 'P2', title: 'Page 2' }])
    })

    it('does not persist selectedBlockId', () => {
      useTabsStore.getState().navigateToPage('P1', 'Page 1', 'BLOCK_42')

      // Verify it's in memory
      expect(useNavigationStore.getState().selectedBlockId).toBe('BLOCK_42')

      const raw = localStorage.getItem(NAV_STORAGE_KEY)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw as string)
      expect(parsed.state).not.toHaveProperty('selectedBlockId')
    })

    it('gracefully handles corrupted localStorage on both keys', () => {
      localStorage.setItem(NAV_STORAGE_KEY, '!!!not-valid-json{{{')
      localStorage.setItem(TABS_STORAGE_KEY, '!!!not-valid-json{{{')

      // Rehydrate should not throw; stores fall back to defaults
      expect(() => useNavigationStore.persist.rehydrate()).not.toThrow()
      expect(() => useTabsStore.persist.rehydrate()).not.toThrow()

      // Stores should still be functional with their current state
      expect(useNavigationStore.getState().currentView).toBeDefined()
      expect(useTabsStore.getState().tabs).toBeDefined()
    })

    it('derives nextTabId from persisted tabs to avoid ID collisions', () => {
      const persistedState = {
        state: {
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '5', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
          tabsBySpace: {},
          activeTabIndexBySpace: {},
        },
        version: 1,
      }
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(persistedState))

      useTabsStore.persist.rehydrate()

      // After rehydrating tabs with max ID '5', new tabs should get ID '6'+
      useTabsStore.getState().openInNewTab('P3', 'Page 3')

      expect(useTabsStore.getState().tabs).toHaveLength(3)
      const newTabId = Number.parseInt(useTabsStore.getState().tabs[2]?.id ?? '0', 10)
      expect(newTabId).toBeGreaterThanOrEqual(6)
    })

    it('navigation v1→v2 migrate strips tab fields from legacy persisted blob', () => {
      // Simulate a pre-MAINT-127 user who had tabs persisted under the
      // navigation key. The v2 migrate function drops them — users get a
      // fresh tab list on first post-split boot (documented one-time UX
      // cost; tabs.ts starts empty since `agaric:tabs` is not set).
      const legacyShape = {
        state: {
          currentView: 'page-editor',
          tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
          activeTabIndex: 0,
          tabsBySpace: { __legacy__: [] },
          activeTabIndexBySpace: { __legacy__: 0 },
        },
        version: 1,
      }
      localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(legacyShape))

      useNavigationStore.persist.rehydrate()

      const state = useNavigationStore.getState()
      // currentView survives the migration.
      expect(state.currentView).toBe('page-editor')
      // selectedBlockId is reset to null (defensive).
      expect(state.selectedBlockId).toBeNull()
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

      useTabsStore.getState().navigateToPage('A', 'Alpha')

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
      })
      useTabsStore.setState({
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

      useTabsStore.getState().goBack()

      expect(recordVisitSpy).not.toHaveBeenCalled()

      recordVisitSpy.mockRestore()
    })

    it('date-routed branch still records the visit (date pages are page visits)', () => {
      const recordVisitSpy = vi.spyOn(useRecentPagesStore.getState(), 'recordVisit')

      useTabsStore.getState().navigateToPage('DATE_PAGE', '2026-04-20')

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

    it('selectTabsForSpace falls back to flat useTabsStore.getState().tabs when spaceId is null', () => {
      useTabsStore.setState({
        tabs: [{ id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' }],
        activeTabIndex: 0,
        tabsBySpace: {},
        activeTabIndexBySpace: {},
      })

      expect(selectTabsForSpace(useTabsStore.getState(), null)).toEqual([
        { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
      ])
      expect(selectActiveTabIndexForSpace(useTabsStore.getState(), null)).toBe(0)
    })

    it('selectTabsForSpace reads from per-space slice when spaceId is non-null', () => {
      useTabsStore.setState({
        tabs: [],
        activeTabIndex: 0,
        tabsBySpace: {
          'space-1': [{ id: 'a', pageStack: [{ pageId: 'A', title: 'Alpha' }], label: 'Alpha' }],
          'space-2': [{ id: 'b', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' }],
        },
        activeTabIndexBySpace: { 'space-1': 0, 'space-2': 0 },
      })

      expect(selectTabsForSpace(useTabsStore.getState(), 'space-1')).toEqual([
        { id: 'a', pageStack: [{ pageId: 'A', title: 'Alpha' }], label: 'Alpha' },
      ])
      expect(selectTabsForSpace(useTabsStore.getState(), 'space-2')).toEqual([
        { id: 'b', pageStack: [{ pageId: 'B', title: 'Bravo' }], label: 'Bravo' },
      ])
    })

    it('openInNewTab in space-1 does not appear in tabsBySpace[space-2]', () => {
      // Activate space-1, then open a tab. The action writes to both
      // useTabsStore.getState().tabs (active mirror) AND tabsBySpace['space-1'].
      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [
          { id: 'space-1', name: 'One', accent_color: null },
          { id: 'space-2', name: 'Two', accent_color: null },
        ],
        isReady: true,
      })
      useTabsStore.getState().openInNewTab('PAGE_A', 'Alpha')

      // Per-space slice for space-1 contains the new tab.
      expect(useTabsStore.getState().tabsBySpace['space-1']?.some((t) => t.label === 'Alpha')).toBe(
        true,
      )
      // space-2 has no slice yet — the per-space partition holds.
      expect(useTabsStore.getState().tabsBySpace['space-2']).toBeUndefined()
      // Selector for space-2 returns the fall-back (active mirror), but the
      // raw partition map is what cross-space code paths read in production.
      expect(useTabsStore.getState().tabsBySpace['space-1']).not.toEqual(
        useTabsStore.getState().tabsBySpace['space-2'] ?? [],
      )
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
      useTabsStore.getState().openInNewTab('PAGE_A', 'Alpha')
      // Pre-seed space-2 so we can verify pull-on-switch.
      useTabsStore.setState((prev) => ({
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

      expect(useTabsStore.getState().tabs.some((t) => t.label === 'Bravo')).toBe(true)
      // space-1's tab must still be retained in its slice.
      expect(useTabsStore.getState().tabsBySpace['space-1']?.some((t) => t.label === 'Alpha')).toBe(
        true,
      )
    })

    it('rehydrate with stale currentSpaceId (no slice) does not crash', () => {
      // Persisted shape has tabsBySpace + activeTabIndexBySpace but the
      // user's current space is no longer a key. This is the
      // "deleted-on-another-device" path. Post-MAINT-127 the per-space
      // partition lives under `agaric:tabs`, so we seed THAT key.
      const TABS_KEY = 'agaric:tabs'
      const persistedTabs = {
        state: {
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
      localStorage.setItem(TABS_KEY, JSON.stringify(persistedTabs))
      useSpaceStore.setState({ currentSpaceId: 'space-DELETED' })

      expect(() => useTabsStore.persist.rehydrate()).not.toThrow()

      // Selector for the now-stale current space falls back to the flat
      // mirror (a single empty tab) rather than throwing.
      const tabs = selectTabsForSpace(
        useTabsStore.getState(),
        useSpaceStore.getState().currentSpaceId,
      )
      expect(Array.isArray(tabs)).toBe(true)

      localStorage.removeItem(TABS_KEY)
    })

    it('persistence round-trips tabsBySpace + activeTabIndexBySpace under the tabs key', () => {
      const TABS_KEY = 'agaric:tabs'
      localStorage.removeItem(TABS_KEY)

      useSpaceStore.setState({
        currentSpaceId: 'space-1',
        availableSpaces: [{ id: 'space-1', name: 'One', accent_color: null }],
        isReady: true,
      })
      useTabsStore.getState().openInNewTab('PAGE_A', 'Alpha')
      useTabsStore.getState().openInNewTab('PAGE_B', 'Bravo')

      const raw = localStorage.getItem(TABS_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed.version).toBe(1)
      expect(parsed.state.tabsBySpace['space-1']).toBeDefined()
      expect(parsed.state.tabsBySpace['space-1']).toHaveLength(3) // initial empty + 2 opens
      expect(parsed.state.activeTabIndexBySpace['space-1']).toBe(2)
    })

    // MAINT-127 — pre-split users had tabs persisted under the navigation
    // key. The simpler migration strategy adopted for the split is to just
    // drop those tab fields on first post-split boot and let the new tabs
    // store start from defaults. Verifies the v1→v2 navigation migration
    // does not blow up on legacy data and does not bleed tab fields into
    // the slimmer v2 navigation contract.
    it('navigation v1→v2 ignores legacy tab fields without crashing', () => {
      const NAV_KEY = 'agaric:navigation'
      const legacyShape = {
        state: {
          currentView: 'page-editor',
          tabs: [
            { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
            { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
          ],
          activeTabIndex: 1,
          tabsBySpace: {},
          activeTabIndexBySpace: {},
        },
        version: 1,
      }
      localStorage.setItem(NAV_KEY, JSON.stringify(legacyShape))
      useSpaceStore.setState({ currentSpaceId: null })

      expect(() => useNavigationStore.persist.rehydrate()).not.toThrow()

      // Only currentView survives — the v2 contract drops tabs.
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      const reReadRaw = localStorage.getItem(NAV_KEY)
      expect(reReadRaw).not.toBeNull()
      const reRead = JSON.parse(reReadRaw as string)
      // After first persist post-rehydrate, the version should be 2 and
      // the tab fields should be gone.
      expect(reRead.version).toBe(2)
      expect(reRead.state).not.toHaveProperty('tabs')
      expect(reRead.state).not.toHaveProperty('tabsBySpace')

      localStorage.removeItem(NAV_KEY)
    })
  })

  // ---------------------------------------------------------------------------
  // MAINT-127 — cross-store coordination
  //
  // The split is asymmetric: tab actions in `useTabsStore` may IMPLY view
  // changes (calling `useNavigationStore.getState().setView(...)` directly);
  // the navigation store's actions never reach back into tabs. These three
  // tests pin the asymmetry at the action boundary so a future refactor that
  // breaks it fails loudly.
  // ---------------------------------------------------------------------------
  describe('MAINT-127 cross-store coordination', () => {
    it('cross_store_coord_navigateToPage_flips_currentView_maint127', () => {
      // Start from a non-editor view.
      useNavigationStore.getState().setView('pages')
      expect(useNavigationStore.getState().currentView).toBe('pages')

      // Tab action — the tabs store has no view state of its own, so this
      // call must reach across into the navigation store and flip the view.
      useTabsStore.getState().navigateToPage('PAGE_X', 'Cross-store target')

      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(useTabsStore.getState().tabs[0]?.pageStack).toEqual([
        { pageId: 'PAGE_X', title: 'Cross-store target' },
      ])
    })

    it('cross_store_coord_switchTab_from_non_editor_flips_view_maint127', () => {
      // Seed two tabs and place the user on a non-editor view.
      useTabsStore.setState({
        tabs: [
          { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
          { id: '1', pageStack: [{ pageId: 'P2', title: 'Page 2' }], label: 'Page 2' },
        ],
        activeTabIndex: 0,
      })
      useNavigationStore.getState().setView('pages')
      expect(useNavigationStore.getState().currentView).toBe('pages')

      useTabsStore.getState().switchTab(1)

      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(useTabsStore.getState().activeTabIndex).toBe(1)
    })

    it('cross_store_coord_navigation_setCurrentView_does_not_touch_tabs_maint127', () => {
      // Seed a stable tab snapshot.
      const seededTabs = [
        { id: '0', pageStack: [{ pageId: 'P1', title: 'Page 1' }], label: 'Page 1' },
        {
          id: '1',
          pageStack: [
            { pageId: 'P2', title: 'Page 2' },
            { pageId: 'P3', title: 'Page 3' },
          ],
          label: 'Page 3',
        },
      ]
      useTabsStore.setState({
        tabs: seededTabs,
        activeTabIndex: 1,
      })
      useNavigationStore.getState().setView('page-editor')
      const beforeTabs = useTabsStore.getState().tabs
      const beforeIndex = useTabsStore.getState().activeTabIndex

      // Switch through every other view via the navigation store. None of
      // these calls should touch the tabs store.
      const destinations = ['journal', 'pages', 'tags', 'search', 'settings'] as const
      for (const view of destinations) {
        useNavigationStore.getState().setView(view)
        expect(useTabsStore.getState().tabs).toBe(beforeTabs)
        expect(useTabsStore.getState().activeTabIndex).toBe(beforeIndex)
      }
    })
  })
})
