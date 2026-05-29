/**
 * Unit tests for `useInPageFindStore` (PEND-52).
 *
 * Covers:
 *  - open$/close lifecycle, including the locked-in selection-→-query /
 *    restore-previous-query behaviour (Q3 from the plan).
 *  - setQuery clears counters immediately on empty.
 *  - next / previous wrap correctly and no-op when total is 0.
 *  - setContainer(null) auto-closes the toolbar (view unmount).
 */

import { afterEach, describe, expect, it } from 'vitest'

import { useInPageFindStore } from '../useInPageFindStore'

afterEach(() => {
  useInPageFindStore.setState({
    open: false,
    query: '',
    toggles: { caseSensitive: false, wholeWord: false, isRegex: false },
    totalMatches: 0,
    currentIndex: -1,
    regexError: null,
    skippedLongNodes: 0,
    container: null,
    lastQuery: '',
  })
})

describe('useInPageFindStore — open$', () => {
  it('opens with a selection-seeded query', () => {
    useInPageFindStore.getState().open$('hello world')
    const s = useInPageFindStore.getState()
    expect(s.open).toBe(true)
    expect(s.query).toBe('hello world')
  })

  it('restores the previous query when no selection is provided', () => {
    // Seed lastQuery via a prior open + close round trip.
    useInPageFindStore.getState().open$('alpha')
    useInPageFindStore.getState().close()
    expect(useInPageFindStore.getState().lastQuery).toBe('alpha')

    // Re-open with no selection — restores the previous query.
    useInPageFindStore.getState().open$()
    expect(useInPageFindStore.getState().query).toBe('alpha')
  })

  it('keeps the current query when re-opened with no selection (Q3)', () => {
    useInPageFindStore.setState({ query: 'beta', lastQuery: 'alpha' })
    useInPageFindStore.getState().open$()
    // Live query wins over stored lastQuery — matches browser behaviour.
    expect(useInPageFindStore.getState().query).toBe('beta')
  })
})

describe('useInPageFindStore — close + setQuery', () => {
  it('close persists query into lastQuery', () => {
    useInPageFindStore.getState().open$('gamma')
    useInPageFindStore.getState().close()
    expect(useInPageFindStore.getState().open).toBe(false)
    expect(useInPageFindStore.getState().lastQuery).toBe('gamma')
  })

  it('setQuery("") clears counters immediately', () => {
    useInPageFindStore.setState({
      open: true,
      query: 'alpha',
      totalMatches: 5,
      currentIndex: 2,
    })
    useInPageFindStore.getState().setQuery('')
    const s = useInPageFindStore.getState()
    expect(s.query).toBe('')
    expect(s.totalMatches).toBe(0)
    expect(s.currentIndex).toBe(-1)
  })
})

describe('useInPageFindStore — navigation', () => {
  it('next wraps from last to first', () => {
    useInPageFindStore.setState({ open: true, totalMatches: 3, currentIndex: 2 })
    useInPageFindStore.getState().next()
    expect(useInPageFindStore.getState().currentIndex).toBe(0)
  })

  it('previous wraps from first to last', () => {
    useInPageFindStore.setState({ open: true, totalMatches: 3, currentIndex: 0 })
    useInPageFindStore.getState().previous()
    expect(useInPageFindStore.getState().currentIndex).toBe(2)
  })

  it('no-ops when total is 0', () => {
    useInPageFindStore.setState({ open: true, totalMatches: 0, currentIndex: -1 })
    useInPageFindStore.getState().next()
    useInPageFindStore.getState().previous()
    expect(useInPageFindStore.getState().currentIndex).toBe(-1)
  })
})

describe('useInPageFindStore — setContainer', () => {
  it('auto-closes the toolbar when the container is detached', () => {
    const host = document.createElement('div')
    useInPageFindStore.getState().setContainer(host)
    useInPageFindStore.getState().open$('alpha')
    expect(useInPageFindStore.getState().open).toBe(true)

    // View unmount → setContainer(null).
    useInPageFindStore.getState().setContainer(null)
    expect(useInPageFindStore.getState().open).toBe(false)
  })
})
