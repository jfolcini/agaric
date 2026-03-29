import { beforeEach, describe, expect, it } from 'vitest'
import { useNavigationStore } from '../navigation'

describe('useNavigationStore', () => {
  beforeEach(() => {
    useNavigationStore.setState({
      currentView: 'journal',
      pageStack: [],
      selectedBlockId: null,
    })
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
  })

  // ---------------------------------------------------------------------------
  // setView
  // ---------------------------------------------------------------------------
  describe('setView', () => {
    it('switches the current view', () => {
      useNavigationStore.getState().setView('search')
      expect(useNavigationStore.getState().currentView).toBe('search')
    })

    it('clears pageStack when switching away from page-editor', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        pageStack: [{ pageId: 'P1', title: 'Page 1' }],
        selectedBlockId: 'B1',
      })

      useNavigationStore.getState().setView('pages')

      const state = useNavigationStore.getState()
      expect(state.currentView).toBe('pages')
      expect(state.pageStack).toEqual([])
      expect(state.selectedBlockId).toBeNull()
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
  })

  // ---------------------------------------------------------------------------
  // goBack
  // ---------------------------------------------------------------------------
  describe('goBack', () => {
    it('pops the last page from the stack', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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

    it('switches to pages view when stack becomes empty', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
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
    })

    it('can replace both pageId and title', () => {
      useNavigationStore.setState({
        currentView: 'page-editor',
        pageStack: [{ pageId: 'OLD_ID', title: 'Old' }],
      })

      useNavigationStore.getState().replacePage('NEW_ID', 'New')

      expect(useNavigationStore.getState().pageStack).toEqual([{ pageId: 'NEW_ID', title: 'New' }])
    })

    it('is a no-op when stack is empty', () => {
      useNavigationStore.setState({
        currentView: 'pages',
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
})
