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
