/**
 * usePageBrowserGrouping — produces the unified `Starred` + `Pages` row
 * model consumed by the `PageBrowser` virtualizer. Owns the two branch
 * helpers (`buildSinglePageBranch`, `buildMultiPageBranch`) and the
 * `sortTopLevelUnits` comparator, plus a thin `useMemo` wrapper that
 * picks the right branch based on the current vault shape.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
 */

import { useMemo } from 'react'
import { buildPageTree, type PageTreeNode } from '@/lib/page-tree'
import { getRecentPages } from '@/lib/recent-pages'
import type { BlockRow } from '../lib/tauri'
import type { SortOption } from './usePageBrowserSort'

/**
 * FEAT-14 — Unified `Starred` + `Pages` row model.
 *
 * The virtualizer renders a single ordered list of rows produced by the
 * grouping memo. Three row kinds:
 *
 *  - `header`: section header (`starred` or `pages`). 36 px.
 *  - `page`:   a flat page row (used inside `Starred`, and inside
 *              `Pages` for top-level non-namespaced pages). 44 px.
 *  - `tree-page`: a namespace-root row inside `Pages` that delegates
 *              recursive subtree rendering to `PageTreeItem`. The
 *              `depth` is always 0 at the top level — the discriminated
 *              `kind` exists so subtree rendering happens via
 *              `PageTreeItem`, not the flat row template. 44 px (the
 *              row itself; descendants render inside the same DOM
 *              wrapper). Variant chosen over an optional `treeNode`
 *              payload on `'page'` so the row template stays small and
 *              `filteredPages[idx]` semantics differ cleanly between
 *              the two (a `tree-page` may not map to a single
 *              `BlockRow`).
 *
 * A starred page that also has `/` in its title appears twice: once as
 * a `page` row inside `Starred` (full `work/foo` title) and once nested
 * inside its `tree-page` root inside `Pages`. Both copies subscribe to
 * the same `useStarredPages` hook state and update together on toggle.
 */
export type PageBrowserRow =
  | { kind: 'header'; section: 'starred' | 'pages'; count: number }
  | { kind: 'page'; page: BlockRow; pageIndex: number }
  | { kind: 'tree-page'; node: PageTreeNode; pageIndex: number; depth: number }

/**
 * Top-level unit fed to the `Pages` section's sort comparator. Each
 * unit is either a flat top-level page (no `/` in its title) or a
 * namespace root (`PageTreeNode` with `name` = the first segment).
 * Sorted together by the active comparator at the top level.
 */
type PagesTopLevelUnit = { type: 'page'; page: BlockRow } | { type: 'tree'; node: PageTreeNode }

/** Walk a tree node, collecting every page id reachable below it. */
function collectDescendantPageIds(node: PageTreeNode, out: string[]): void {
  if (node.pageId) out.push(node.pageId)
  for (const child of node.children) collectDescendantPageIds(child, out)
}

/**
 * Return value of the row-grouping computation. Pulled to a named
 * type so the two branch helpers below share a stable shape.
 */
export interface GroupedRowsResult {
  filteredPages: Array<BlockRow | null>
  groupedRows: PageBrowserRow[]
  pageIndexToRowIndex: number[]
  hasStarred: boolean
  hasPages: boolean
}

/**
 * Single-page (or empty) flat-vault branch — preserved from FEAT-12,
 * avoids visual noise on a brand-new vault. Only kicks in when the
 * lone page is non-namespaced; a single namespaced page falls
 * through to the multi-page branch so the tree shape renders
 * consistently with the multi-namespaced-page case. Extracted from
 * the grouping memo so each helper stays under biome's cognitive
 * complexity threshold.
 */
export function buildSinglePageBranch(
  filteredPagesUnsorted: BlockRow[],
  sortPages: (input: BlockRow[]) => BlockRow[],
): GroupedRowsResult {
  const sorted = sortPages(filteredPagesUnsorted)
  const rows: PageBrowserRow[] = sorted.map((page, pageIndex) => ({
    kind: 'page',
    page,
    pageIndex,
  }))
  const idMap = sorted.map((_, i) => i)
  return {
    filteredPages: sorted as Array<BlockRow | null>,
    groupedRows: rows,
    pageIndexToRowIndex: idMap,
    hasStarred: false,
    hasPages: sorted.length > 0,
  }
}

/**
 * Multi-page branch — produces the unified `Starred` + `Pages` row
 * model described in the FEAT-14 doc-comment on `PageBrowserRow`.
 * Extracted from the grouping memo to keep biome's cognitive
 * complexity below 25 per function.
 */
export function buildMultiPageBranch(
  filteredPagesUnsorted: BlockRow[],
  sortPages: (input: BlockRow[]) => BlockRow[],
  sortOption: SortOption,
  starredSet: ReadonlySet<string>,
): GroupedRowsResult {
  const starredFiltered: BlockRow[] = []
  // Pages section input. A page enters here when:
  //   - it is non-starred (always), OR
  //   - it is starred AND namespaced (the duplication case — also
  //     appears in `Starred` for direct access).
  // A starred non-namespaced page lives ONLY in `Starred`; including
  // it under `Pages` too would duplicate the row without value.
  const pagesSourcePages: BlockRow[] = []
  for (const p of filteredPagesUnsorted) {
    const starred = starredSet.has(p.id)
    const isNamespaced = (p.content ?? '').includes('/')
    if (starred) starredFiltered.push(p)
    if (!starred || isNamespaced) pagesSourcePages.push(p)
  }

  // `Starred` section: flat list, sorted independently by the
  // active comparator. Renders the FULL title (e.g. `work/foo`) so
  // a starred-and-namespaced page is recognizable at a glance.
  const starredSorted = sortPages(starredFiltered)

  // `Pages` section: build a single tree from every input page so
  // hybrid nodes (a page named `work` with children under
  // `work/...`) merge into one root rather than rendering twice.
  // Each root then becomes a top-level unit:
  //   - root.pageId set AND no children → render as a flat `page`
  //     row (single-segment top-level page).
  //   - otherwise → render as a `tree-page` row (pure namespace OR
  //     hybrid). `PageTreeItem` handles the hybrid case internally.
  // Subtree child order tracks `pagesSorted` input order.
  const pagesSorted = sortPages(pagesSourcePages)
  const allRoots = buildPageTree(pagesSorted)
  const topLevelUnits: PagesTopLevelUnit[] = allRoots.map((node) => {
    if (node.pageId && node.children.length === 0) {
      const page = filteredPagesUnsorted.find((p) => p.id === node.pageId)
      if (page) return { type: 'page', page }
    }
    return { type: 'tree', node }
  })

  // Sort the heterogeneous top-level list. Comparator semantics
  // mirror `sortPages`: alphabetical → name; created → newest
  // descendant ULID (or own ULID for flat); recent → newest
  // descendant visit time (or own for flat) with name fallback.
  const recentMap =
    sortOption === 'recent' ? new Map(getRecentPages().map((rp) => [rp.id, rp.visitedAt])) : null
  const sortedTopLevel = sortTopLevelUnits(topLevelUnits, sortOption, recentMap)

  const rows: PageBrowserRow[] = []
  const idMap: number[] = []
  const pageRows: Array<BlockRow | null> = []
  let pageIndex = 0
  if (starredSorted.length > 0) {
    rows.push({ kind: 'header', section: 'starred', count: starredSorted.length })
    for (const page of starredSorted) {
      idMap.push(rows.length)
      rows.push({ kind: 'page', page, pageIndex })
      pageRows.push(page)
      pageIndex += 1
    }
  }
  if (sortedTopLevel.length > 0) {
    rows.push({ kind: 'header', section: 'pages', count: sortedTopLevel.length })
    for (const unit of sortedTopLevel) {
      idMap.push(rows.length)
      if (unit.type === 'page') {
        rows.push({ kind: 'page', page: unit.page, pageIndex })
        pageRows.push(unit.page)
      } else {
        rows.push({ kind: 'tree-page', node: unit.node, pageIndex, depth: 0 })
        // A namespace root has no single backing page (or is a
        // hybrid — `node.pageId` may be set). For keyboard Enter on
        // the row we record the hybrid page if present, else null.
        pageRows.push(
          unit.node.pageId
            ? (filteredPagesUnsorted.find((p) => p.id === unit.node.pageId) ?? null)
            : null,
        )
      }
      pageIndex += 1
    }
  }
  return {
    filteredPages: pageRows,
    groupedRows: rows,
    pageIndexToRowIndex: idMap,
    hasStarred: starredSorted.length > 0,
    hasPages: sortedTopLevel.length > 0,
  }
}

/**
 * Sort the heterogeneous "top-level units" list (flat page rows + tree
 * roots) under `Pages`. Comparator semantics mirror `sortPages`:
 *
 *  - alphabetical → by page.content (flat) / node.name (tree).
 *  - created → by ULID (flat = own id; tree = newest descendant id).
 *  - recent → by visit time with name fallback (flat = own time;
 *    tree = newest descendant time across its subtree).
 *
 * Pulled to module scope so the memo dependency list stays clean.
 */
export function sortTopLevelUnits(
  units: PagesTopLevelUnit[],
  sortOption: SortOption,
  recentMap: Map<string, string> | null,
): PagesTopLevelUnit[] {
  const out = [...units]
  const nameOf = (u: PagesTopLevelUnit): string =>
    u.type === 'page' ? (u.page.content ?? '') : u.node.name
  const createdIdOf = (u: PagesTopLevelUnit): string => {
    if (u.type === 'page') return u.page.id
    const ids: string[] = []
    collectDescendantPageIds(u.node, ids)
    return ids.length > 0 ? ids.reduce((a, b) => (a > b ? a : b)) : ''
  }
  const recentTimeOf = (u: PagesTopLevelUnit): string | null => {
    if (recentMap == null) return null
    if (u.type === 'page') return recentMap.get(u.page.id) ?? null
    const ids: string[] = []
    collectDescendantPageIds(u.node, ids)
    let best: string | null = null
    for (const id of ids) {
      const t = recentMap.get(id)
      if (t && (best == null || t > best)) best = t
    }
    return best
  }
  if (sortOption === 'alphabetical') {
    out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  } else if (sortOption === 'created') {
    out.sort((a, b) => createdIdOf(b).localeCompare(createdIdOf(a)))
  } else if (sortOption === 'recent') {
    out.sort((a, b) => {
      const at = recentTimeOf(a)
      const bt = recentTimeOf(b)
      if (at && bt) return bt.localeCompare(at)
      if (at) return -1
      if (bt) return 1
      return nameOf(a).localeCompare(nameOf(b))
    })
  }
  return out
}

export interface UsePageBrowserGroupingArgs {
  filteredPagesUnsorted: BlockRow[]
  sortPages: (input: BlockRow[]) => BlockRow[]
  sortOption: SortOption
  starredIds: ReadonlySet<string>
  isSinglePageVault: boolean
}

/**
 * Hook wrapper that selects the appropriate branch (`buildSinglePageBranch`
 * for a brand-new vault, `buildMultiPageBranch` otherwise) and memoises the
 * resulting `GroupedRowsResult` against its inputs.
 */
export function usePageBrowserGrouping({
  filteredPagesUnsorted,
  sortPages,
  sortOption,
  starredIds,
  isSinglePageVault,
}: UsePageBrowserGroupingArgs): GroupedRowsResult {
  return useMemo(() => {
    // `starredIds` is sourced from `useStarredPages()` and changes
    // whenever a star toggle happens (in this view or another mounted
    // hook instance), so pages move between sections immediately.
    return isSinglePageVault
      ? buildSinglePageBranch(filteredPagesUnsorted, sortPages)
      : buildMultiPageBranch(filteredPagesUnsorted, sortPages, sortOption, starredIds)
  }, [isSinglePageVault, filteredPagesUnsorted, sortPages, sortOption, starredIds])
}
