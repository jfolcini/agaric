/**
 * Tests for the #135 pinned-search-scope store — a global localStorage
 * preference for the mobile search sheet's default segment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearPinnedSearchScope,
  getPinnedSearchScope,
  setPinnedSearchScope,
} from '../pinned-search-scope'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('pinned-search-scope', () => {
  it('returns null when nothing is pinned', () => {
    expect(getPinnedSearchScope()).toBeNull()
  })

  it('round-trips a pinned in-page scope', () => {
    setPinnedSearchScope('in-page')
    expect(getPinnedSearchScope()).toBe('in-page')
  })

  it('round-trips a pinned all-pages scope', () => {
    setPinnedSearchScope('all-pages')
    expect(getPinnedSearchScope()).toBe('all-pages')
  })

  it('clear removes the pin', () => {
    setPinnedSearchScope('all-pages')
    clearPinnedSearchScope()
    expect(getPinnedSearchScope()).toBeNull()
  })

  it('rejects an invalid stored value', () => {
    localStorage.setItem('pinned_search_scope', 'bogus-mode')
    expect(getPinnedSearchScope()).toBeNull()
  })

  it('is global — not partitioned by space (single key)', () => {
    setPinnedSearchScope('in-page')
    expect(localStorage.getItem('pinned_search_scope')).toBe('in-page')
  })
})
