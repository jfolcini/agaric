/**
 * Tests for usePageBrowserSort — localStorage-backed sort preference
 * for `PageBrowser`, plus the `sortPages` callback used by both the
 * `Starred` and `Pages` sections to stay in lock-step.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePage } from '../../__tests__/fixtures'
import { usePageBrowserSort } from '../usePageBrowserSort'

vi.mock('@/lib/recent-pages', () => ({
  getRecentPages: vi.fn(() => []),
}))

import { getRecentPages } from '@/lib/recent-pages'

const mockedGetRecentPages = vi.mocked(getRecentPages)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mockedGetRecentPages.mockReturnValue([])
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

  it('sortPages applies alphabetical comparator to the input', () => {
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: 'P1', content: 'Bravo' }),
      makePage({ id: 'P2', content: 'Alpha' }),
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.content)).toEqual(['Alpha', 'Bravo'])
  })

  it('sortPages with "created" option sorts by ULID descending', () => {
    localStorage.setItem('page-browser-sort', 'created')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: '01AAAA', content: 'Older' }),
      makePage({ id: '01ZZZZ', content: 'Newer' }),
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.id)).toEqual(['01ZZZZ', '01AAAA'])
  })

  it('sortPages with "recent" option uses the recent-pages map', () => {
    localStorage.setItem('page-browser-sort', 'recent')
    mockedGetRecentPages.mockReturnValue([
      { id: 'P1', title: 'Older visit', visitedAt: '2025-01-15T10:00:00Z' },
      { id: 'P2', title: 'Newer visit', visitedAt: '2025-01-15T12:00:00Z' },
    ])
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: 'P1', content: 'Older visit' }),
      makePage({ id: 'P2', content: 'Newer visit' }),
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.id)).toEqual(['P2', 'P1'])
  })

  it('returns a new array — does not mutate the input', () => {
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: 'P1', content: 'Bravo' }),
      makePage({ id: 'P2', content: 'Alpha' }),
    ]
    const original = [...pages]
    const sorted = result.current.sortPages(pages)
    // Input order untouched.
    expect(pages.map((p) => p.id)).toEqual(original.map((p) => p.id))
    // Output is a different reference.
    expect(sorted).not.toBe(pages)
  })
})
