import { beforeEach, describe, expect, it } from 'vitest'
import type { View } from '../navigation'
import {
  defaultModeForView,
  type SearchSheetMode,
  useSearchSheetStore,
} from '../useSearchSheetStore'

describe('useSearchSheetStore', () => {
  beforeEach(() => {
    useSearchSheetStore.setState({
      open: false,
      mode: 'in-page',
      query: '',
    })
  })

  describe('open$', () => {
    it('opens with the supplied default mode and clears the query', () => {
      useSearchSheetStore.setState({ query: 'stale' })
      useSearchSheetStore.getState().open$('all-pages')
      const state = useSearchSheetStore.getState()
      expect(state.open).toBe(true)
      expect(state.mode).toBe('all-pages')
      expect(state.query).toBe('')
    })

    it('respects the in-page default', () => {
      useSearchSheetStore.getState().open$('in-page')
      expect(useSearchSheetStore.getState().mode).toBe('in-page')
    })
  })

  describe('close', () => {
    it('closes and resets the query', () => {
      useSearchSheetStore.setState({ open: true, query: 'alpha', mode: 'all-pages' })
      useSearchSheetStore.getState().close()
      const state = useSearchSheetStore.getState()
      expect(state.open).toBe(false)
      expect(state.query).toBe('')
      // mode survives close — next open$ supplies the desired default.
      expect(state.mode).toBe('all-pages')
    })
  })

  describe('setMode', () => {
    it('switches segments without clearing the query (Q1: one-tap re-scope)', () => {
      useSearchSheetStore.setState({ open: true, mode: 'in-page', query: 'alpha' })
      useSearchSheetStore.getState().setMode('all-pages')
      const state = useSearchSheetStore.getState()
      expect(state.mode).toBe('all-pages')
      expect(state.query).toBe('alpha')
    })
  })

  describe('setQuery', () => {
    it('updates the query string', () => {
      useSearchSheetStore.setState({ open: true })
      useSearchSheetStore.getState().setQuery('hello')
      expect(useSearchSheetStore.getState().query).toBe('hello')
    })
  })
})

describe('defaultModeForView', () => {
  it("returns 'in-page' for views that read a single page", () => {
    expect(defaultModeForView('journal')).toBe<SearchSheetMode>('in-page')
    expect(defaultModeForView('page-editor')).toBe<SearchSheetMode>('in-page')
  })

  it("returns 'all-pages' for every other view", () => {
    const others: View[] = [
      'search',
      'pages',
      'tags',
      'trash',
      'status',
      'history',
      'templates',
      'settings',
      'graph',
    ]
    for (const view of others) {
      expect(defaultModeForView(view)).toBe<SearchSheetMode>('all-pages')
    }
  })
})
