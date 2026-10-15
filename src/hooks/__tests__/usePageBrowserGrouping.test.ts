/**
 * Tests for usePageBrowserGrouping — covers the two branch helpers
 * (`buildSinglePageBranch`, `buildMultiPageBranch`) that drive
 * `PageBrowser`'s unified `Starred` + `Pages` row model.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makePage } from '@/__tests__/fixtures'
import {
  buildMultiPageBranch,
  buildSinglePageBranch,
  usePageBrowserGrouping,
} from '@/hooks/usePageBrowserGrouping'
import type { PageTreeNode } from '@/lib/page-tree'

describe('buildSinglePageBranch', () => {
  it('returns hasPages=false for an empty input', () => {
    const result = buildSinglePageBranch([])
    expect(result.hasPages).toBe(false)
    expect(result.hasStarred).toBe(false)
    expect(result.groupedRows).toEqual([])
    expect(result.filteredPages).toEqual([])
    expect(result.pageIndexToRowIndex).toEqual([])
  })

  it('emits a single flat page row for a one-page vault — no headers', () => {
    const p = makePage({ id: 'P1', content: 'Solo' })
    const result = buildSinglePageBranch([p])
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(true)
    expect(result.groupedRows).toHaveLength(1)
    expect(result.groupedRows[0]).toMatchObject({ kind: 'page', pageIndex: 0 })
    // No header offset — pageIndex maps 1:1 to row index.
    expect(result.pageIndexToRowIndex).toEqual([0])
  })

  it('keeps the server order of its input', () => {
    const p1 = makePage({ id: 'P1', content: 'Bravo' })
    const p2 = makePage({ id: 'P2', content: 'Alpha' })
    const result = buildSinglePageBranch([p1, p2])
    expect(result.groupedRows[0]).toMatchObject({ kind: 'page', page: { id: 'P1' } })
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: 'P2' } })
  })
})

describe('buildMultiPageBranch', () => {
  it('emits a Pages-only section when no pages are starred', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch([a, b], new Set())
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(true)
    // 1 header + 2 page rows.
    expect(result.groupedRows[0]).toMatchObject({ kind: 'header', section: 'pages', count: 2 })
    expect(result.groupedRows.filter((r) => r.kind === 'page')).toHaveLength(2)
  })

  it('puts starred non-namespaced pages ONLY in the Starred section (no duplicate)', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch([a, b], new Set(['P1']) as ReadonlySet<string>)
    expect(result.hasStarred).toBe(true)
    expect(result.hasPages).toBe(true)
    // First header is starred with count 1, then the starred page.
    expect(result.groupedRows[0]).toMatchObject({ kind: 'header', section: 'starred', count: 1 })
    expect(result.groupedRows[1]).toMatchObject({ kind: 'page', page: { id: 'P1' } })
    // The Pages header carries count 1 (only Bravo, not Alpha).
    expect(result.groupedRows[2]).toMatchObject({ kind: 'header', section: 'pages', count: 1 })
    expect(result.groupedRows[3]).toMatchObject({ kind: 'page', page: { id: 'P2' } })
  })

  it('starred-and-namespaced pages render TWICE — once in Bookmarks, once nested in Pages', () => {
    const a = makePage({ id: 'P1', content: 'work/foo' })
    const b = makePage({ id: 'P2', content: 'home' })
    const starred: ReadonlySet<string> = new Set(['P1'])
    const result = buildMultiPageBranch([a, b], starred)
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

  // #3286 — both `node.pageId -> BlockRow` lookups now go through the id map
  // built alongside `starredFiltered`/`pagesSourcePages` instead of a linear
  // `filteredPages.find`. Pins the resolution the map has to preserve:
  // the flat-page arm AND the hybrid tree-root arm (a page named `work` that
  // also has `work/...` children), which is the only caller of the second one.
  it('resolves a hybrid namespace root to its backing page row', () => {
    const root = makePage({ id: 'P1', content: 'work' })
    const child = makePage({ id: 'P2', content: 'work/foo' })
    const flat = makePage({ id: 'P3', content: 'home' })
    const result = buildMultiPageBranch([root, child, flat], new Set())
    const treeIndex = result.groupedRows.findIndex((r) => r.kind === 'tree-page')
    expect(treeIndex).toBeGreaterThanOrEqual(0)
    const treeRow = result.groupedRows[treeIndex]
    expect(treeRow).toMatchObject({ kind: 'tree-page', node: { pageId: 'P1' } })
    // Keyboard Enter on the hybrid row opens `work` itself — the row must
    // carry the backing BlockRow, not null.
    const pageIndex = (treeRow as { pageIndex: number }).pageIndex
    expect(result.filteredPages[pageIndex]).toBe(root)
    // ...and the flat arm still resolves its own row.
    const flatRow = result.groupedRows.find((r) => r.kind === 'page' && r.page.id === 'P3')
    expect(flatRow).toBeDefined()
    expect(result.filteredPages).toContain(flat)
  })

  it('pageIndexToRowIndex skips header rows', () => {
    const a = makePage({ id: 'P1', content: 'Alpha' })
    const b = makePage({ id: 'P2', content: 'Bravo' })
    const result = buildMultiPageBranch([a, b], new Set(['P1']) as ReadonlySet<string>)
    // 4 rows total: [starred header, P1, pages header, P2]
    // Page index 0 → row 1, page index 1 → row 3.
    expect(result.pageIndexToRowIndex).toEqual([1, 3])
  })

  it('returns hasStarred=false hasPages=false for an empty input', () => {
    const result = buildMultiPageBranch([], new Set())
    expect(result.hasStarred).toBe(false)
    expect(result.hasPages).toBe(false)
    expect(result.groupedRows).toEqual([])
  })

  // #5371 — the server orders the pages; a namespace root sits where its
  // first page arrived, and the flat rows keep their places around it.
  it('keeps the server order, a namespace root at its first page', () => {
    const pages = [
      makePage({ id: 'P1', content: 'zeta' }),
      makePage({ id: 'P2', content: 'work/b' }),
      makePage({ id: 'P3', content: 'alpha' }),
      makePage({ id: 'P4', content: 'work/a' }),
    ]
    const result = buildMultiPageBranch(pages, new Set())
    expect(
      result.groupedRows
        .slice(1)
        .map((row) =>
          row.kind === 'page' ? row.page.id : row.kind === 'tree-page' ? row.node.name : '',
        ),
    ).toEqual(['P1', 'work', 'P3'])
  })
})

describe('matchedPageCount (E7)', () => {
  it('single-page branch reports the flat page count', () => {
    const result = buildSinglePageBranch([makePage({ id: 'P1', content: 'Solo' })])
    expect(result.matchedPageCount).toBe(1)
  })

  it('empty single-page branch reports zero', () => {
    expect(buildSinglePageBranch([]).matchedPageCount).toBe(0)
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
    const result = buildMultiPageBranch(pages, new Set())
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
    const result = buildMultiPageBranch(pages, starred)
    // Five distinct matched pages.
    expect(result.matchedPageCount).toBe(5)
    // The grouped row array does NOT equal the distinct count (subtree
    // collapse + starred duplication skew it).
    expect(result.filteredPages.length).not.toBe(result.matchedPageCount)
  })
})

describe('duplicate titles (#4709)', () => {
  /** Every page id reachable from the grouped rows (flat rows + subtrees). */
  function reachableIds(rows: ReturnType<typeof buildMultiPageBranch>['groupedRows']): string[] {
    const ids: string[] = []
    const visitNode = (node: PageTreeNode): void => {
      if (node.pageId) ids.push(node.pageId)
      for (const child of node.children) visitNode(child)
    }
    for (const row of rows) {
      if (row.kind === 'page') ids.push(row.page.id)
      else if (row.kind === 'tree-page') visitNode(row.node)
    }
    return ids
  }

  it('gives every duplicate-title page a row of its own', () => {
    const pages = [
      makePage({ id: 'P1', content: 'Agaric' }),
      makePage({ id: 'P2', content: 'Agaric' }),
      makePage({ id: 'P3', content: 'iadm' }),
    ]
    const result = buildMultiPageBranch(pages, new Set())
    // Header + one row per page.
    expect(result.groupedRows.filter((r) => r.kind === 'page')).toHaveLength(3)
    expect(reachableIds(result.groupedRows).toSorted()).toEqual(['P1', 'P2', 'P3'])
  })

  it('keeps a nested duplicate reachable inside its subtree', () => {
    const pages = [
      makePage({ id: 'P1', content: 'DevEx/workstations/avature' }),
      makePage({ id: 'P2', content: 'DevEx/workstations/avature' }),
    ]
    const result = buildMultiPageBranch(pages, new Set())
    expect(reachableIds(result.groupedRows).toSorted()).toEqual(['P1', 'P2'])
  })

  it('matchedPageCount counts DISTINCT pages, and every one of them has a row', () => {
    // The count chip and the SR result count are driven by
    // `matchedPageCount`. It was already the honest distinct count — the
    // defect was on the other side of the equation: the tree dropped
    // duplicate-title pages, so the chip promised more matches than the
    // list could show. Pin the two against each other rather than
    // restating the implementation.
    const pages = [
      makePage({ id: 'P1', content: 'Agaric' }),
      makePage({ id: 'P2', content: 'Agaric' }),
      makePage({ id: 'P3', content: 'work/dup' }),
      makePage({ id: 'P4', content: 'work/dup' }),
      makePage({ id: 'P5', content: 'work/solo' }),
    ]
    const result = buildMultiPageBranch(pages, new Set())
    expect(result.matchedPageCount).toBe(5)
    const ids = reachableIds(result.groupedRows)
    // Distinct — no page counted twice by the rows either.
    expect(new Set(ids).size).toBe(result.matchedPageCount)
    expect(ids).toHaveLength(result.matchedPageCount)
  })

  it('flags the duplicate flat rows so the row renderer can disambiguate them', () => {
    const pages = [
      makePage({ id: 'P1', content: 'Agaric' }),
      makePage({ id: 'P2', content: 'Agaric' }),
      makePage({ id: 'P3', content: 'iadm' }),
    ]
    const result = buildMultiPageBranch(pages, new Set())
    const flagFor = (id: string) =>
      result.groupedRows.find((r) => r.kind === 'page' && r.page.id === id) as
        | Extract<(typeof result.groupedRows)[number], { kind: 'page' }>
        | undefined
    expect(flagFor('P1')?.duplicateTitle).toBe(true)
    expect(flagFor('P2')?.duplicateTitle).toBe(true)
    // The unique title is NOT flagged — the cue stays off the common row.
    expect(flagFor('P3')?.duplicateTitle).toBeUndefined()
  })
})

describe('usePageBrowserGrouping (hook)', () => {
  it('selects the single-page branch for a one-page non-namespaced vault', () => {
    const p = makePage({ id: 'P1', content: 'Solo' })
    const { result } = renderHook(() =>
      usePageBrowserGrouping({
        filteredPages: [p],
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
        filteredPages: [a, b],
        starredIds: new Set(),
        isSinglePageVault: false,
      }),
    )
    // Multi-page branch — pages header present.
    expect(result.current.groupedRows[0]).toMatchObject({ kind: 'header', section: 'pages' })
  })
})
