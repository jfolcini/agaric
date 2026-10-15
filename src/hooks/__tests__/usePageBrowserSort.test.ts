/**
 * Tests for usePageBrowserSort — the localStorage-backed sort preference for
 * `PageBrowser`, and the wire `PageSort` each option sends (#5371). That rows
 * keep the order the server sent is pinned in `PageBrowser.sort.test.tsx`.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pageSortWireFor, usePageBrowserSort } from '@/hooks/usePageBrowserSort'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('usePageBrowserSort', () => {
  it('defaults to "alphabetical" when no preference is stored', () => {
    const { result } = renderHook(() => usePageBrowserSort())
    expect(result.current.sortOption).toBe('alphabetical')
  })

  it('reads the persisted bare-string preference on mount', () => {
    localStorage.setItem('page-browser-sort', 'recent')
    const { result } = renderHook(() => usePageBrowserSort())
    expect(result.current.sortOption).toBe('recent')
  })

  it('persists the new option as a bare string (no JSON encoding)', () => {
    const { result } = renderHook(() => usePageBrowserSort())
    act(() => {
      result.current.setSortOption('created')
    })
    expect(result.current.sortOption).toBe('created')
    expect(localStorage.getItem('page-browser-sort')).toBe('created')
  })

  it('falls back to default when stored value is outside the allowlist', () => {
    localStorage.setItem('page-browser-sort', 'not-a-valid-option')
    const { result } = renderHook(() => usePageBrowserSort())
    expect(result.current.sortOption).toBe('alphabetical')
  })

  it('reads the retired "default" sort as "created"', () => {
    localStorage.setItem('page-browser-sort', 'default')
    const { result } = renderHook(() => usePageBrowserSort())
    expect(result.current.sortOption).toBe('created')
  })

  it('accepts all 6 sort options', () => {
    const allSorts = [
      'alphabetical',
      'recent',
      'created',
      'recently-modified',
      'most-linked',
      'most-content',
    ] as const
    for (const sort of allSorts) {
      localStorage.setItem('page-browser-sort', sort)
      const { result, unmount } = renderHook(() => usePageBrowserSort())
      expect(result.current.sortOption).toBe(sort)
      unmount()
    }
  })
})

describe('pageSortWireFor', () => {
  it('sends every option to the server as its own sort', () => {
    expect(pageSortWireFor('alphabetical')).toBe('alphabetical')
    expect(pageSortWireFor('recent')).toBe('last-opened')
    expect(pageSortWireFor('created')).toBe('created')
    expect(pageSortWireFor('recently-modified')).toBe('recently-modified')
    expect(pageSortWireFor('most-linked')).toBe('most-linked')
    expect(pageSortWireFor('most-content')).toBe('most-content')
  })
})
