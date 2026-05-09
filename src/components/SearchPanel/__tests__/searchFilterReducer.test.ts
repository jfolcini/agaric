/**
 * Tests for searchFilterReducer (PEND-30 D-3).
 *
 * Validates:
 *  - Initial state is the published constant.
 *  - Each action transitions correctly.
 *  - Idempotent guards (add-tag-filter dedup).
 *  - Pure-function semantics: same state object on no-op.
 *  - `hasActiveFilters` derivation.
 */

import { describe, expect, it } from 'vitest'
import {
  hasActiveFilters,
  INITIAL_SEARCH_FILTER_STATE,
  type SearchFilterState,
  searchFilterReducer,
} from '../searchFilterReducer'

describe('searchFilterReducer', () => {
  it('exposes a frozen-shape initial state', () => {
    expect(INITIAL_SEARCH_FILTER_STATE).toEqual({
      filterPageId: null,
      filterPageTitle: null,
      filterTagIds: [],
      filterTagNames: [],
    })
  })

  describe('set-page-filter', () => {
    it('applies a page filter on a clean state', () => {
      const next = searchFilterReducer(INITIAL_SEARCH_FILTER_STATE, {
        type: 'set-page-filter',
        pageId: 'PAGE_A',
        pageTitle: 'Project Apollo',
      })
      expect(next.filterPageId).toBe('PAGE_A')
      expect(next.filterPageTitle).toBe('Project Apollo')
    })

    it('replaces an existing page filter', () => {
      const after1 = searchFilterReducer(INITIAL_SEARCH_FILTER_STATE, {
        type: 'set-page-filter',
        pageId: 'PAGE_A',
        pageTitle: 'A',
      })
      const after2 = searchFilterReducer(after1, {
        type: 'set-page-filter',
        pageId: 'PAGE_B',
        pageTitle: 'B',
      })
      expect(after2.filterPageId).toBe('PAGE_B')
      expect(after2.filterPageTitle).toBe('B')
    })

    it('does not touch tag-filter state', () => {
      const seeded: SearchFilterState = {
        ...INITIAL_SEARCH_FILTER_STATE,
        filterTagIds: ['T1'],
        filterTagNames: ['todo'],
      }
      const next = searchFilterReducer(seeded, {
        type: 'set-page-filter',
        pageId: 'P1',
        pageTitle: 'Page',
      })
      expect(next.filterTagIds).toEqual(['T1'])
      expect(next.filterTagNames).toEqual(['todo'])
    })
  })

  describe('clear-page-filter', () => {
    it('resets page-filter fields to null', () => {
      const seeded: SearchFilterState = {
        ...INITIAL_SEARCH_FILTER_STATE,
        filterPageId: 'P1',
        filterPageTitle: 'Page',
      }
      const next = searchFilterReducer(seeded, { type: 'clear-page-filter' })
      expect(next.filterPageId).toBeNull()
      expect(next.filterPageTitle).toBeNull()
    })

    it('preserves tag filters', () => {
      const seeded: SearchFilterState = {
        filterPageId: 'P1',
        filterPageTitle: 'Page',
        filterTagIds: ['T1', 'T2'],
        filterTagNames: ['todo', 'done'],
      }
      const next = searchFilterReducer(seeded, { type: 'clear-page-filter' })
      expect(next.filterTagIds).toEqual(['T1', 'T2'])
      expect(next.filterTagNames).toEqual(['todo', 'done'])
    })
  })

  describe('add-tag-filter', () => {
    it('appends a tag to an empty list', () => {
      const next = searchFilterReducer(INITIAL_SEARCH_FILTER_STATE, {
        type: 'add-tag-filter',
        tagId: 'T1',
        tagName: 'todo',
      })
      expect(next.filterTagIds).toEqual(['T1'])
      expect(next.filterTagNames).toEqual(['todo'])
    })

    it('appends a second tag preserving order', () => {
      const after1 = searchFilterReducer(INITIAL_SEARCH_FILTER_STATE, {
        type: 'add-tag-filter',
        tagId: 'T1',
        tagName: 'todo',
      })
      const after2 = searchFilterReducer(after1, {
        type: 'add-tag-filter',
        tagId: 'T2',
        tagName: 'done',
      })
      expect(after2.filterTagIds).toEqual(['T1', 'T2'])
      expect(after2.filterTagNames).toEqual(['todo', 'done'])
    })

    it('is idempotent: adding the same tag twice is a no-op', () => {
      const after1 = searchFilterReducer(INITIAL_SEARCH_FILTER_STATE, {
        type: 'add-tag-filter',
        tagId: 'T1',
        tagName: 'todo',
      })
      const after2 = searchFilterReducer(after1, {
        type: 'add-tag-filter',
        tagId: 'T1',
        tagName: 'todo',
      })
      // Same reference — the reducer returns `state` on no-op.
      expect(after2).toBe(after1)
    })
  })

  describe('remove-tag-filter', () => {
    it('removes the tag at the given index', () => {
      const seeded: SearchFilterState = {
        ...INITIAL_SEARCH_FILTER_STATE,
        filterTagIds: ['T1', 'T2', 'T3'],
        filterTagNames: ['a', 'b', 'c'],
      }
      const next = searchFilterReducer(seeded, { type: 'remove-tag-filter', index: 1 })
      expect(next.filterTagIds).toEqual(['T1', 'T3'])
      expect(next.filterTagNames).toEqual(['a', 'c'])
    })

    it('is a no-op for out-of-range index', () => {
      const seeded: SearchFilterState = {
        ...INITIAL_SEARCH_FILTER_STATE,
        filterTagIds: ['T1'],
        filterTagNames: ['a'],
      }
      const next = searchFilterReducer(seeded, { type: 'remove-tag-filter', index: 5 })
      expect(next.filterTagIds).toEqual(['T1'])
      expect(next.filterTagNames).toEqual(['a'])
    })
  })

  describe('clear-all', () => {
    it('returns the initial state regardless of seeded values', () => {
      const seeded: SearchFilterState = {
        filterPageId: 'P1',
        filterPageTitle: 'Page',
        filterTagIds: ['T1', 'T2'],
        filterTagNames: ['a', 'b'],
      }
      const next = searchFilterReducer(seeded, { type: 'clear-all' })
      expect(next).toEqual(INITIAL_SEARCH_FILTER_STATE)
    })
  })
})

describe('hasActiveFilters', () => {
  it('returns false on the initial state', () => {
    expect(hasActiveFilters(INITIAL_SEARCH_FILTER_STATE)).toBe(false)
  })

  it('returns true when a page filter is applied', () => {
    expect(
      hasActiveFilters({
        ...INITIAL_SEARCH_FILTER_STATE,
        filterPageId: 'P1',
        filterPageTitle: 'Page',
      }),
    ).toBe(true)
  })

  it('returns true when at least one tag filter is applied', () => {
    expect(
      hasActiveFilters({
        ...INITIAL_SEARCH_FILTER_STATE,
        filterTagIds: ['T1'],
        filterTagNames: ['todo'],
      }),
    ).toBe(true)
  })
})
