/**
 * usePageBrowserGrouping — produces the unified `Starred` + `Pages` row
 * model consumed by the `PageBrowser` virtualizer. Owns the two branch
 * helpers (`buildSinglePageBranch`, `buildMultiPageBranch`), plus a thin
 * `useMemo` wrapper that picks the right branch based on the current vault
 * shape.
 *
 * The pages arrive in the server's sort order (#5371) and every section keeps
 * it: a namespace root sits where its first page arrived.
 *
 * Extracted from `PageBrowser.tsx`.
 */

import { useMemo } from 'react'

import type { BlockRow } from '@/lib/bindings'
import { buildPageTree, type PageTreeNode } from '@/lib/page-tree'

/**
 * Unified `Starred` + `Pages` row model.
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
  | {
      kind: 'page'
      page: BlockRow
      pageIndex: number
      /**
       * #4709 — this page's title is shared with another page at the
       * same tree level, so the row gets a creation-date cue (page ids
       * are unique; titles are not). Only ever set on `Pages`-section
       * rows: `Starred` renders the full path and is a short, manually
       * curated list, so the cue would be noise there.
       */
      duplicateTitle?: boolean
    }
  | { kind: 'tree-page'; node: PageTreeNode; pageIndex: number; depth: number }

/**
 * Top-level unit of the `Pages` section: either a flat top-level page (no
 * `/` in its title) or a namespace root (`PageTreeNode` with `name` = the
 * first segment).
 */
type PagesTopLevelUnit =
  | { type: 'page'; page: BlockRow; duplicateTitle: boolean }
  | { type: 'tree'; node: PageTreeNode }

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
  /**
   * E7 — the count of DISTINCT matched pages. `filteredPages` is the
   * grouped-row array, not a flat page list: a namespace subtree
   * collapses to a single `tree-page` row (under-count) and a
   * starred+namespaced page appears once under `Starred` and again
   * nested under `Pages` (double-count). Drive the "X of Y matching"
   * count chip and the SR result count from THIS number, never
   * `filteredPages.length`.
   */
  matchedPageCount: number
}

/**
 * Single-page (or empty) flat-vault branch — preserved,
 * avoids visual noise on a brand-new vault. Only kicks in when the
 * lone page is non-namespaced; a single namespaced page falls
 * through to the multi-page branch so the tree shape renders
 * consistently with the multi-namespaced-page case. Extracted from
 * the grouping memo so each helper stays under oxlint's eslint/complexity
 * threshold.
 */
export function buildSinglePageBranch(filteredPages: BlockRow[]): GroupedRowsResult {
  const rows: PageBrowserRow[] = filteredPages.map((page, pageIndex) => ({
    kind: 'page',
    page,
    pageIndex,
  }))
  const idMap = filteredPages.map((_, i) => i)
  return {
    filteredPages,
    groupedRows: rows,
    pageIndexToRowIndex: idMap,
    hasStarred: false,
    hasPages: filteredPages.length > 0,
    // Single-page branch: every input row is a distinct flat page.
    matchedPageCount: filteredPages.length,
  }
}

/**
 * Multi-page branch — produces the unified `Starred` + `Pages` row
 * Model described in the doc-comment on `PageBrowserRow`.
 * Extracted from the grouping memo to keep oxlint's eslint/complexity
 * below 25 per function.
 */
export function buildMultiPageBranch(
  filteredPages: BlockRow[],
  starredSet: ReadonlySet<string>,
): GroupedRowsResult {
  // `Starred` section: flat list. Renders the FULL title (e.g. `work/foo`)
  // so a starred-and-namespaced page is recognizable at a glance.
  const starredFiltered: BlockRow[] = []
  // Pages section input. A page enters here when:
  //   - it is non-starred (always), OR
  //   - it is starred AND namespaced (the duplication case — also
  //     appears in `Starred` for direct access).
  // A starred non-namespaced page lives ONLY in `Starred`; including
  // it under `Pages` too would duplicate the row without value.
  const pagesSourcePages: BlockRow[] = []
  // #3286 — `id → row` index built in the walk that already exists, so the
  // two lookups below are O(1) instead of a `filteredPages.find(...)`
  // scan per top-level unit (the Pages browser's infinite query accumulates
  // every fetched page, so that was O(P²) in the loaded-page count). First
  // writer wins, matching `.find`'s first-match semantics.
  const byId = new Map<string, BlockRow>()
  for (const p of filteredPages) {
    if (!byId.has(p.id)) byId.set(p.id, p)
    const starred = starredSet.has(p.id)
    const isNamespaced = (p.content ?? '').includes('/')
    if (starred) starredFiltered.push(p)
    if (!starred || isNamespaced) pagesSourcePages.push(p)
  }

  // `Pages` section: build a single tree from every input page so
  // hybrid nodes (a page named `work` with children under
  // `work/...`) merge into one root rather than rendering twice.
  // Each root then becomes a top-level unit:
  //   - root.pageId set AND no children → render as a flat `page`
  //     row (single-segment top-level page).
  //   - otherwise → render as a `tree-page` row (pure namespace OR
  //     hybrid). `PageTreeItem` handles the hybrid case internally.
  // Root and subtree child order track input order.
  const allRoots = buildPageTree(pagesSourcePages)
  const topLevelUnits: PagesTopLevelUnit[] = allRoots.map((node) => {
    if (node.pageId && node.children.length === 0) {
      const page = byId.get(node.pageId)
      // #4709 — a duplicate-title root still renders as a flat row (it
      // keeps the star / multi-select / metadata affordances a
      // `tree-page` row does not have); the flag drives the
      // creation-date cue that tells the two identical titles apart.
      if (page) return { type: 'page', page, duplicateTitle: node.duplicateTitle === true }
    }
    return { type: 'tree', node }
  })

  const rows: PageBrowserRow[] = []
  const idMap: number[] = []
  const pageRows: Array<BlockRow | null> = []
  let pageIndex = 0
  if (starredFiltered.length > 0) {
    rows.push({ kind: 'header', section: 'starred', count: starredFiltered.length })
    for (const page of starredFiltered) {
      idMap.push(rows.length)
      rows.push({ kind: 'page', page, pageIndex })
      pageRows.push(page)
      pageIndex += 1
    }
  }
  if (topLevelUnits.length > 0) {
    rows.push({ kind: 'header', section: 'pages', count: topLevelUnits.length })
    for (const unit of topLevelUnits) {
      idMap.push(rows.length)
      if (unit.type === 'page') {
        rows.push({
          kind: 'page',
          page: unit.page,
          pageIndex,
          ...(unit.duplicateTitle ? { duplicateTitle: true } : {}),
        })
        pageRows.push(unit.page)
      } else {
        rows.push({ kind: 'tree-page', node: unit.node, pageIndex, depth: 0 })
        // A namespace root has no single backing page (or is a
        // hybrid — `node.pageId` may be set). For keyboard Enter on
        // the row we record the hybrid page if present, else null.
        pageRows.push(unit.node.pageId ? (byId.get(unit.node.pageId) ?? null) : null)
      }
      pageIndex += 1
    }
  }
  return {
    filteredPages: pageRows,
    groupedRows: rows,
    pageIndexToRowIndex: idMap,
    hasStarred: starredFiltered.length > 0,
    hasPages: topLevelUnits.length > 0,
    // E7 — `filteredPages` is the distinct matched-page set the
    // grouping consumed: one entry per page, before namespace collapse
    // and before the starred+namespaced duplication. That is the
    // honest "matching pages" count. #4709 — it stays the right basis
    // now that duplicate-title pages each get their own node: the count
    // is one per input page either way, whereas deriving it from the
    // tree would have silently dropped them along with their rows.
    matchedPageCount: filteredPages.length,
  }
}

export interface UsePageBrowserGroupingArgs {
  /** The matched pages, in the server's sort order. */
  filteredPages: BlockRow[]
  starredIds: ReadonlySet<string>
  isSinglePageVault: boolean
}

/**
 * Hook wrapper that selects the appropriate branch (`buildSinglePageBranch`
 * for a brand-new vault, `buildMultiPageBranch` otherwise) and memoises the
 * resulting `GroupedRowsResult` against its inputs.
 */
export function usePageBrowserGrouping({
  filteredPages,
  starredIds,
  isSinglePageVault,
}: UsePageBrowserGroupingArgs): GroupedRowsResult {
  return useMemo(
    () =>
      // `starredIds` is sourced from `useStarredPages()` and changes
      // whenever a star toggle happens (in this view or another mounted
      // hook instance), so pages move between sections immediately.
      isSinglePageVault
        ? buildSinglePageBranch(filteredPages)
        : buildMultiPageBranch(filteredPages, starredIds),
    [isSinglePageVault, filteredPages, starredIds],
  )
}
