/**
 * Tests for usePageBrowserSort — localStorage-backed sort preference
 * for `PageBrowser`, plus the `sortPages` callback used by both the
 * `Starred` and `Pages` sections to stay in lock-step.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePage } from '../../__tests__/fixtures'
import { isFrontendOnlySort, usePageBrowserSort } from '../usePageBrowserSort'

// #1149 — recent-pages moved to the zustand store. `sortPages` reads the
// snapshot helper `getRecentPagesForSpace`; override only that and keep the
// rest of the store module real.
vi.mock('@/stores/recent-pages', async (importActual) => {
  const actual = await importActual<typeof import('@/stores/recent-pages')>()
  return { ...actual, getRecentPagesForSpace: vi.fn(() => []) }
})

import { getRecentPagesForSpace } from '@/stores/recent-pages'

const mockedGetRecentPages = vi.mocked(getRecentPagesForSpace)

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

  // ── PEND-56 — 4 new sort modes ──────────────────────────────────────

  it('sortPages with "default" option sorts by ULID ascending (raw backend order)', () => {
    localStorage.setItem('page-browser-sort', 'default')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: '01ZZZZ', content: 'Z' }),
      makePage({ id: '01AAAA', content: 'A' }),
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.id)).toEqual(['01AAAA', '01ZZZZ'])
  })

  it('sortPages with "recently-modified" reads the lastModifiedAt field DESC', () => {
    localStorage.setItem('page-browser-sort', 'recently-modified')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      // Metadata-row shape (camelCase) — only metadata rows expose
      // lastModifiedAt; BlockRow callers fall back to alphabetical.
      makeMetaRow('P1', 'A', { lastModifiedAt: 1767225600000 }), // 2026-01-01
      makeMetaRow('P2', 'B', { lastModifiedAt: 1777593600000 }), // 2026-05-01
      makeMetaRow('P3', 'C', { lastModifiedAt: 1772323200000 }), // 2026-03-01
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.id)).toEqual(['P2', 'P3', 'P1'])
  })

  // PEND-58e E14: count ties break by `id ASC` (server keyset parity),
  // not by title — so equal-count groups don't reshuffle as pages stream.
  it('sortPages with "most-linked" reads inboundLinkCount DESC, id-ASC tiebreaker', () => {
    localStorage.setItem('page-browser-sort', 'most-linked')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makeMetaRow('P1', 'Bravo', { inboundLinkCount: 5 }),
      makeMetaRow('P2', 'Alpha', { inboundLinkCount: 5 }),
      makeMetaRow('P3', 'Delta', { inboundLinkCount: 10 }),
    ]
    const sorted = result.current.sortPages(pages)
    // Delta (10) first; the 5-tie breaks by id ASC: P1 before P2.
    expect(sorted.map((p) => p.id)).toEqual(['P3', 'P1', 'P2'])
  })

  it('sortPages with "most-content" reads childBlockCount DESC, id-ASC tiebreaker', () => {
    localStorage.setItem('page-browser-sort', 'most-content')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makeMetaRow('P1', 'Bravo', { childBlockCount: 50 }),
      makeMetaRow('P2', 'Alpha', { childBlockCount: 50 }),
      makeMetaRow('P3', 'Delta', { childBlockCount: 100 }),
    ]
    const sorted = result.current.sortPages(pages)
    // Delta (100) first; the 50-tie breaks by id ASC: P1 before P2.
    expect(sorted.map((p) => p.id)).toEqual(['P3', 'P1', 'P2'])
  })

  it('metadata sort falls back to alphabetical when rows are BlockRow (no metadata)', () => {
    // The flag-off code path uses BlockRow (no lastModifiedAt). The
    // sort must not crash — falls through to alphabetical.
    localStorage.setItem('page-browser-sort', 'recently-modified')
    const { result } = renderHook(() => usePageBrowserSort())
    const pages = [
      makePage({ id: 'P1', content: 'Bravo' }),
      makePage({ id: 'P2', content: 'Alpha' }),
    ]
    const sorted = result.current.sortPages(pages)
    expect(sorted.map((p) => p.content)).toEqual(['Alpha', 'Bravo'])
  })

  // ── PEND-58d D3 — isFrontendOnlySort helper ─────────────────────────

  it('isFrontendOnlySort is true for the three frontend-only sorts', () => {
    expect(isFrontendOnlySort('alphabetical')).toBe(true)
    expect(isFrontendOnlySort('recent')).toBe(true)
    expect(isFrontendOnlySort('created')).toBe(true)
  })

  it('isFrontendOnlySort is false for "default" (raw server id-ASC order)', () => {
    expect(isFrontendOnlySort('default')).toBe(false)
  })

  it('isFrontendOnlySort is false for the three server-side sorts', () => {
    expect(isFrontendOnlySort('recently-modified')).toBe(false)
    expect(isFrontendOnlySort('most-linked')).toBe(false)
    expect(isFrontendOnlySort('most-content')).toBe(false)
  })

  it('parser accepts all 7 sort options', () => {
    const allSorts = [
      'alphabetical',
      'recent',
      'created',
      'recently-modified',
      'most-linked',
      'most-content',
      'default',
    ] as const
    for (const sort of allSorts) {
      localStorage.setItem('page-browser-sort', sort)
      const { result, unmount } = renderHook(() => usePageBrowserSort())
      expect(result.current.sortOption).toBe(sort)
      unmount()
    }
  })
})

// Minimal metadata-row factory for the new sort tests. The
// PageWithMetadataRow shape is camelCase; the sortPages discriminator
// looks for `lastModifiedAt` to detect it. The returned object is cast
// to the type the production wrapper would produce, via the import.
import type { PageWithMetadataRow } from '../../lib/tauri'

function makeMetaRow(
  id: string,
  content: string,
  meta: { lastModifiedAt?: number; inboundLinkCount?: number; childBlockCount?: number } = {},
): PageWithMetadataRow {
  return {
    id,
    blockType: 'page',
    content,
    parentId: null,
    position: null,
    deletedAt: null,
    todoState: null,
    priority: null,
    dueDate: null,
    scheduledDate: null,
    pageId: id,
    lastModifiedAt: meta.lastModifiedAt ?? 1767225600000, // 2026-01-01
    inboundLinkCount: meta.inboundLinkCount ?? 0,
    childBlockCount: meta.childBlockCount ?? 0,
    flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
  }
}
