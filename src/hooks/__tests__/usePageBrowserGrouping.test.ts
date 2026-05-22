/**
 * Tests for usePageBrowserGrouping — covers the two branch helpers
 * (`buildSinglePageBranch`, `buildMultiPageBranch`) and the
 * `sortTopLevelUnits` comparator that drive `PageBrowser`'s unified
 * `Starred` + `Pages` row model (FEAT-14).
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makePage } from '../../__tests__/fixtures'
import type { BlockRow } from '../../lib/tauri'
import {
  buildMultiPageBranch,
  buildSinglePageBranch,
  usePageBrowserGrouping,
} from '../usePageBrowserGrouping'

vi.mock('@/lib/recent-pages', () => ({
  getRecentPages: vi.fn(() => []),
}))

/** Identity sort — keeps inputs in their original order so assertions are stable. */
function identitySort(input: BlockRow[]): BlockRow[] {
  return [...input]
}

describe('buildSinglePageBranch', () => {
  it('returns hasPages=false for an empty input', () => {
    const result = buildSinglePageBranch([], identitySort)
    expect(result.hasPages).toBe(false)
    expect(result.hasStarred).toBe(false)
    expect(result.groupedRows).toEqual([])
    expect(result.filteredPages).toEqual([])
    expect(result.pageIndexToRowIndex).toEqual([])
  })

  it('emits a single flat page row for a one-page vault — no headers', () => {
    const p = makePage({ id: 'P1', content: 'Solo' })
    const result = buildSinglePageBranch([p], identitySort)
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(true)
    expect(result.groupedRows).toHaveLength(1)
    expect(result.groupedRows[0]).toMatchObject({ kind: 'page', pageIndex: 0 })
    // No header offset — pageIndex maps 1:1 to row index.
    expect(result.pageIndexToRowIndex).toEqual([0])
  })

  it('passes pages through the supplied sortPages callback', () => {
    const p1 = makePage({ id: 'P1', content: 'Bravo' })
    const p2 = makePage({ id: 'P2', content: 'Alpha' })
    const sortByName = (input: BlockRow[]) =>
      [...input].sort((a, b) => (a.content ?? '').localeCompare(b.content ?? ''))
    const result = buildSinglePageBranch([p1, p2], sortByName)
    // Sorted: Alpha first.
    expect(result.groupedRows[0]).toMatchObject({ kind: 'page', page: { id: 'P2' } })
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: 'P1' } })
  })
})

describe('buildMultiPageBranch', () => {
  it('emits a Pages-only section when no pages are starred', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch([a, b], identitySort, 'alphabetical', new Set())
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(true)
    // 1 header + 2 page rows.
    expect(result.groupedRows[0]).toMatchObject({ kind: 'header', section: 'pages', count: 2 })
    expect(result.groupedRows.filter((r) => r.kind === 'page')).toHaveLength(2)
  })

  it('puts starred non-namespaced pages ONLY in the Starred section (no duplicate)', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch(
      [a, b],
      identitySort,
      'alphabetical',
      new Set(['P1']) as ReadonlySet<string>,
    )
    expect(result.hasStarred).toBe(true)
    expect(result.hasPages).toBe(true)
    // First header is starred with count 1, then the starred page.
    expect(result.groupedRows[0]).toMatchObject({ kind: 'header', section: 'starred', count: 1 })
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: 'P1' } })
    // The Pages header carries count 1 (only Bravo, not Alpha).
    expect(result.groupedRows[2]).toMatchObject({ kind: 'header', section: 'pages', count: 1 })
    expect(result.groupedRows[3]).toMatchObject({ kind: 'page', page: { id: 'P2' } })
  })

  it('starred-and-namespaced pages render TWICE — once in Starred, once nested in Pages', () => {
    const a = makePage({ id: 'P1', content: 'work/foo' })
    const b = makePage({ id: 'P2', content: 'home' })
    const starred: ReadonlySet<string> = new Set(['P1'])
    const result = buildMultiPageBranch([a, b], identitySort, 'alphabetical', starred)
    // Starred section count = 1 (only the namespaced starred page).
    const starredHeader = result.groupedRows.find(
      (r) => r.kind === 'header' && r.section === 'starred',
    )
    expect(starredHeader).toMatchObject({ count: 1 })
    // Pages section count = 2: the `work` namespace root + flat `home`.
    const pagesHeader = result.groupedRows.find((r) => r.kind === 'header' && r.section === 'pages')
    expect(pagesHeader).toMatchObject({ count: 2 })
    // The Pages section carries a tree-page row (the `work` namespace root)
    // because P1 is namespaced and now lives nested inside Pages too.
    const treeRow = result.groupedRows.find((r) => r.kind === 'tree-page')
    expect(treeRow).toBeDefined()
  })

  it('pageIndexToRowIndex skips header rows', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch(
      [a, b],
      identitySort,
      'alphabetical',
      new Set(['P1']) as ReadonlySet<string>,
    )
    // 4 rows total: [starred header, P1, pages header, P2]
    // Page index 0 → row 1, page index 1 → row 3.
    expect(result.pageIndexToRowIndex).toEqual([1, 3])
  })

  it('returns hasStarred=false hasPages=false for an empty input', () => {
    const result = buildMultiPageBranch([], identitySort, 'alphabetical', new Set())
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(false)
    expect(result.groupedRows).toEqual([])
  })

  it('created sort orders top-level pages by ULID descending', () => {
    const older = makePage({ id: '01AAAA', content: 'Older' })
    const newer = makePage({ id: '01ZZZZ', content: 'Newer' })
    const result = buildMultiPageBranch([older, newer], identitySort, 'created', new Set())
    // Pages section starts at row 1 (after the header).
    const firstPageRow = result.groupedRows[1]
    const secondPageRow = result.groupedRows[2]
    // Newer ULID comes first.
    expect(firstPageRow).toMatchObject({ kind: 'page', page: { id: '01ZZZZ' } })
    expect(secondPageRow).toMatchObject({ kind: 'page', page: { id: '01AAAA' } })
  })
})

describe('matchedPageCount (E7)', () => {
  it('single-page branch reports the flat page count', () => {
    const result = buildSinglePageBranch([makePage({ id: 'P1', content: 'Solo' })], identitySort)
    expect(result.matchedPageCount).toBe(1)
  })

  it('empty single-page branch reports zero', () => {
    expect(buildSinglePageBranch([], identitySort).matchedPageCount).toBe(0)
  })

  it('counts DISTINCT matched pages, not grouped rows, for a namespaced subtree', () => {
    // A 3-page namespace subtree collapses to ONE tree-page row, so a
    // grouped-row count would under-count. `matchedPageCount` must report
    // the true distinct page count.
    const pages = [
      makePage({ id: 'P1', content: 'work/a' }),
      makePage({ id: 'P2', content: 'work/b' }),
      makePage({ id: 'P3', content: 'work/c' }),
    ]
    const result = buildMultiPageBranch(pages, identitySort, 'alphabetical', new Set())
    expect(result.matchedPageCount).toBe(3)
    // Sanity: the grouped row array (`filteredPages`) is SHORTER than the
    // distinct page count because the subtree collapsed to one row.
    expect(result.filteredPages.length).toBeLessThan(result.matchedPageCount)
  })

  it('does not double-count a starred+namespaced page (Starred + nested in Pages)', () => {
    // `team/y` is starred AND namespaced: it renders once in Starred and
    // again nested under the `team` tree in Pages. A grouped-row count
    // would over-count it. Combined with a collapsing `work` subtree the
    // grouped count diverges from the distinct page count in both
    // directions; `matchedPageCount` stays honest.
    const pages = [
      makePage({ id: 'P1', content: 'work/a' }),
      makePage({ id: 'P2', content: 'work/b' }),
      makePage({ id: 'P3', content: 'work/c' }),
      makePage({ id: 'P4', content: 'home' }),
      makePage({ id: 'P5', content: 'team/y' }),
    ]
    const starred: ReadonlySet<string> = new Set(['P5'])
    const result = buildMultiPageBranch(pages, identitySort, 'alphabetical', starred)
    // Five distinct matched pages.
    expect(result.matchedPageCount).toBe(5)
    // The grouped row array does NOT equal the distinct count (subtree
    // collapse + starred duplication skew it).
    expect(result.filteredPages.length).not.toBe(result.matchedPageCount)
  })
})

describe('sortTopLevelUnits id tiebreak (E14)', () => {
  it('recent sort breaks visit-less ties by id ASC (matching the server keyset), not title', () => {
    // Neither page has a recent-visit time (the mocked getRecentPages
    // returns []), so BOTH fall to the tiebreaker — the common case, since
    // most pages have never been visited. The server streams these ties in
    // id ASC order; the client must match that, NOT reorder by title.
    // Title order would put 'Alpha' first if title were the tiebreak; id
    // ASC instead puts the lower id ('Zebra') first. This is the row
    // reshuffle E14 fixes: as pages stream in, equal-key rows must keep a
    // stable, server-aligned order.
    const lowerIdLaterTitle = makePage({ id: '01AAAA', content: 'Zebra' })
    const higherIdEarlierTitle = makePage({ id: '01ZZZZ', content: 'Alpha' })
    const result = buildMultiPageBranch(
      [higherIdEarlierTitle, lowerIdLaterTitle],
      identitySort,
      'recent',
      new Set(),
    )
    // id ASC: 01AAAA ('Zebra') first, 01ZZZZ ('Alpha') second.
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: '01AAAA' } })
    expect(result.groupedRows[2]).toMatchObject({ kind: 'page', page: { id: '01ZZZZ' } })
  })

  it('recent ties are order-independent (stable regardless of input order)', () => {
    // Feed the SAME two visit-less pages in the opposite input order; the
    // id-ASC tiebreak must produce the identical output order, proving the
    // result no longer depends on incoming (stream) order.
    const a = makePage({ id: '01AAAA', content: 'Zebra' })
    const z = makePage({ id: '01ZZZZ', content: 'Alpha' })
    const forward = buildMultiPageBranch([a, z], identitySort, 'recent', new Set())
    const reversed = buildMultiPageBranch([z, a], identitySort, 'recent', new Set())
    const idsOf = (r: typeof forward) =>
      r.groupedRows
        .filter((row) => row.kind === 'page')
        .map((row) => (row as { page: BlockRow }).page.id)
    expect(idsOf(forward)).toEqual(['01AAAA', '01ZZZZ'])
    expect(idsOf(reversed)).toEqual(['01AAAA', '01ZZZZ'])
  })

  it('created sort orders by ULID DESC and stays deterministic', () => {
    const a = makePage({ id: '01AAAA', content: 'Zeta' })
    const b = makePage({ id: '01BBBB', content: 'Alpha' })
    const result = buildMultiPageBranch([a, b], identitySort, 'created', new Set())
    // created = ULID DESC: 01BBBB before 01AAAA regardless of title.
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: '01BBBB' } })
    expect(result.groupedRows[2]).toMatchObject({ kind: 'page', page: { id: '01AAAA' } })
  })
})

describe('usePageBrowserGrouping (hook)', () => {
  it('selects the single-page branch for a one-page non-namespaced vault', () => {
    const p = makePage({ id: 'P1', content: 'Solo' })
    const { result } = renderHook(() =>
      usePageBrowserGrouping({
        filteredPagesUnsorted: [p],
        sortPages: identitySort,
        sortOption: 'alphabetical',
        starredIds: new Set(),
        isSinglePageVault: true,
      }),
    )
    // Single-page branch: no header rows.
    expect(result.current.groupedRows).toHaveLength(1)
    expect(result.current.groupedRows[0]).toMatchObject({ kind: 'page' })
    expect(result.current.hasStarred).toBe(false)
  })

  it('selects the multi-page branch otherwise', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const { result } = renderHook(() =>
      usePageBrowserGrouping({
        filteredPagesUnsorted: [a, b],
        sortPages: identitySort,
        sortOption: 'alphabetical',
        starredIds: new Set(),
        isSinglePageVault: false,
      }),
    )
    // Multi-page branch — pages header present.
    expect(result.current.groupedRows[0]).toMatchObject({ kind: 'header', section: 'pages' })
  })
})
