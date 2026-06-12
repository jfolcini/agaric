/**
 * Tests for the #131 recent-searches store — per-space, capped, deduped,
 * most-recent-first localStorage list of search terms.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSpaceStore } from '../../stores/space'
import { addRecentSearch, clearRecentSearches, getRecentSearches } from '../recent-searches'

const initialSpace = useSpaceStore.getState()

beforeEach(() => {
  localStorage.clear()
  useSpaceStore.setState({ ...initialSpace, currentSpaceId: 'SPACE_A' })
})

afterEach(() => {
  localStorage.clear()
  useSpaceStore.setState({ ...initialSpace })
})

describe('recent-searches', () => {
  it('returns an empty list when nothing has been searched', () => {
    expect(getRecentSearches()).toEqual([])
  })

  it('records a term and reads it back', () => {
    addRecentSearch('hello')
    expect(getRecentSearches()).toEqual(['hello'])
  })

  it('orders most-recent first', () => {
    addRecentSearch('one')
    addRecentSearch('two')
    addRecentSearch('three')
    expect(getRecentSearches()).toEqual(['three', 'two', 'one'])
  })

  it('deduplicates case-insensitively, moving the re-run term to the top with its new casing', () => {
    addRecentSearch('Foo')
    addRecentSearch('bar')
    addRecentSearch('foo')
    expect(getRecentSearches()).toEqual(['foo', 'bar'])
  })

  it('trims terms and ignores empty / whitespace-only input', () => {
    addRecentSearch('  spaced  ')
    addRecentSearch('   ')
    addRecentSearch('')
    expect(getRecentSearches()).toEqual(['spaced'])
  })

  it('caps the list at 8 entries, evicting the oldest', () => {
    for (let i = 1; i <= 10; i++) addRecentSearch(`term${i}`)
    const result = getRecentSearches()
    expect(result).toHaveLength(8)
    expect(result[0]).toBe('term10')
    expect(result).not.toContain('term1')
    expect(result).not.toContain('term2')
  })

  it('partitions by space — terms from one space are invisible in another', () => {
    addRecentSearch('alpha')
    useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
    expect(getRecentSearches()).toEqual([])
    addRecentSearch('beta')
    expect(getRecentSearches()).toEqual(['beta'])
    useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
    expect(getRecentSearches()).toEqual(['alpha'])
  })

  it('clearRecentSearches empties the active-space list', () => {
    addRecentSearch('x')
    addRecentSearch('y')
    clearRecentSearches()
    expect(getRecentSearches()).toEqual([])
  })

  it('survives a corrupted store value (non-array JSON)', () => {
    localStorage.setItem('recent_searches:SPACE_A', '{"not":"an array"}')
    expect(getRecentSearches()).toEqual([])
  })

  it('filters non-string entries from a hand-edited store', () => {
    localStorage.setItem('recent_searches:SPACE_A', JSON.stringify(['ok', 42, '', 'fine']))
    expect(getRecentSearches()).toEqual(['ok', 'fine'])
  })
})
