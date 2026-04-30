/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 */

import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { FileText, Plus, Search, Star, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { HighlightMatch } from '@/components/HighlightMatch'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { PageTreeItem } from '@/components/PageTreeItem'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { buildPageTree, type PageTreeNode } from '@/lib/page-tree'
import { getRecentPages } from '@/lib/recent-pages'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { useStarredPages } from '../hooks/useStarredPages'
import type { BlockRow } from '../lib/tauri'
import { createPageInSpace, listBlocks, resolvePageByAlias } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { ViewHeader } from './ViewHeader'

type SortOption = 'alphabetical' | 'recent' | 'created'

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
type PageBrowserRow =
  | { kind: 'header'; section: 'starred' | 'pages'; count: number }
  | { kind: 'page'; page: BlockRow; pageIndex: number }
  | { kind: 'tree-page'; node: PageTreeNode; pageIndex: number; depth: number }

const HEADER_ROW_HEIGHT = 36
const PAGE_ROW_HEIGHT = 44

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
interface GroupedRowsResult {
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
function buildSinglePageBranch(
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
function buildMultiPageBranch(
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
function sortTopLevelUnits(
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

const SORT_STORAGE_KEY = 'page-browser-sort'

function readSortPreference(): SortOption {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY)
    if (stored === 'alphabetical' || stored === 'recent' || stored === 'created') return stored
  } catch {
    // localStorage unavailable
  }
  return 'alphabetical'
}

function writeSortPreference(value: SortOption): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, value)
  } catch {
    // localStorage unavailable
  }
}

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — honour the current space. When the `SpaceStore`
  // has not yet hydrated (`isReady === false`) we render a
  // `LoadingSkeleton` instead of firing `listBlocks` so the first render
  // never leaks cross-space pages. Once ready, `currentSpaceId` is
  // threaded to `listBlocks` so the backend filters results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const queryFn = useCallback(
    (cursor?: string) =>
      listBlocks({
        blockType: 'page',
        ...(cursor != null && { cursor }),
        limit: 50,
        spaceId: currentSpaceId ?? undefined,
      }),
    [currentSpaceId],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    setItems: setPages,
  } = usePaginatedQuery(queryFn, {
    onError: t('pageBrowser.loadFailed'),
    enabled: spaceIsReady,
  })

  const { deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete } = usePageDelete(setPages)

  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [filterText, setFilterText] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>(readSortPreference)
  const { starredIds, isStarred, toggle: toggleStar } = useStarredPages()
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [aliasMatchId, setAliasMatchId] = useState<string | null>(null)
  // Stable id base for section header `aria-labelledby` wiring. Two
  // headers (`starred` and `other`) share the same prefix.
  const sectionLabelId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newPageInputRef = useRef<HTMLInputElement>(null)
  // Register the "new page" input as the primary-focus target for this view
  // so switching to Pages via sidebar lands the cursor in the create form
  // instead of the generic #main-content container (UX-220).
  useRegisterPrimaryFocus(newPageInputRef)
  // Tracks the handleCreateUnder focus setTimeout so we can cancel it on
  // unmount and avoid focusing a stale DOM node (#MAINT-14).
  const pendingFocusRef = useRef<number | null>(null)

  // Clear any pending focus timer on unmount.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (pages.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(
        t('pageBrowser.loadedMorePages', { count: pages.length - prevLengthRef.current }),
      )
    } else if (pages.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = pages.length
  }, [pages.length, t])

  // Alias resolution for filter
  useEffect(() => {
    if (!filterText.trim()) {
      setAliasMatchId(null)
      return
    }
    resolvePageByAlias(filterText.trim())
      .then((result) => {
        setAliasMatchId(result ? result[0] : null)
      })
      .catch((err) => {
        logger.warn('PageBrowser', 'alias resolution failed', { query: filterText.trim() }, err)
        setAliasMatchId(null)
      })
  }, [filterText])

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    // FEAT-3 Phase 2 — a page must belong to a space. On the rare
    // first-boot path where `SpaceStore` has not yet hydrated we
    // refuse to create and surface a toast rather than silently
    // creating an unscoped page. The `isReady` gate above normally
    // prevents this branch from firing.
    const activeSpaceId = useSpaceStore.getState().currentSpaceId
    if (activeSpaceId == null) {
      toast.error(t('pageBrowser.spaceNotReady'))
      return
    }
    setIsCreating(true)
    try {
      const newId = await createPageInSpace({ content: name, spaceId: activeSpaceId })
      const newPage: BlockRow = {
        id: newId,
        block_type: 'page',
        content: name,
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: newId,
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
      onPageSelect?.(newId, name)
    } catch (error) {
      toast.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t, onPageSelect])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    if (pendingFocusRef.current !== null) {
      window.clearTimeout(pendingFocusRef.current)
    }
    pendingFocusRef.current = window.setTimeout(() => {
      pendingFocusRef.current = null
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 0)
  }, [])

  const handleSortChange = useCallback((value: SortOption) => {
    setSortOption(value)
    writeSortPreference(value)
  }, [])

  /**
   * Sort an array of pages in place by the active sort option.
   * Same comparator the legacy single-list sort used — extracted so we
   * can apply it independently inside the starred / other groups.
   */
  const sortPages = useCallback(
    (input: BlockRow[]): BlockRow[] => {
      const sorted = [...input]
      if (sortOption === 'alphabetical') {
        sorted.sort((a, b) => (a.content ?? '').localeCompare(b.content ?? ''))
      } else if (sortOption === 'created') {
        sorted.sort((a, b) => b.id.localeCompare(a.id))
      } else if (sortOption === 'recent') {
        const recentPages = getRecentPages()
        const recentMap = new Map(recentPages.map((rp) => [rp.id, rp.visitedAt]))
        sorted.sort((a, b) => {
          const aTime = recentMap.get(a.id)
          const bTime = recentMap.get(b.id)
          if (aTime && bTime) return bTime.localeCompare(aTime)
          if (aTime) return -1
          if (bTime) return 1
          return (a.content ?? '').localeCompare(b.content ?? '')
        })
      }
      return sorted
    },
    [sortOption],
  )

  /**
   * Pages narrowed by the search input + alias resolver.
   * Sort/grouping is applied below — both `Starred` and `Pages`
   * sections consume the same filtered pool.
   */
  const filteredPagesUnsorted = useMemo(() => {
    const trimmed = filterText.trim()
    if (!trimmed) return pages
    // UX-247 — Unicode-aware case- / diacritic-insensitive match so
    // Turkish (`İstanbul` ↔ `istanbul`), German (`Straße` ↔
    // `strasse`), and accented (`café` ↔ `cafe`) titles fold together
    // the way users expect from interactive filters.
    return pages.filter(
      (p) => matchesSearchFolded(p.content ?? '', trimmed) || p.id === aliasMatchId,
    )
  }, [pages, filterText, aliasMatchId])

  /**
   * FEAT-14 — Unified `Starred` + `Pages` row buckets.
   *
   * Replaces the FEAT-12 `isTreeMode ? flat : grouped` cliff with a
   * stable two-section model:
   *
   *  - `Starred` (flat, conditional): every starred filtered page,
   *    rendered with its full title (`work/foo` not just `foo`),
   *    sorted by the active comparator independently of `Pages`.
   *  - `Pages`: a single section that interleaves top-level flat
   *    pages (titles without `/`) and namespace roots (expandable
   *    `PageTreeItem`s). Top-level units are sorted together by the
   *    active comparator. Subtree rendering is unchanged below the
   *    root level — `PageTreeItem` recurses internally.
   *
   * A starred page that also has `/` in its title appears **twice**:
   * once as a flat row in `Starred`, once nested in its tree position
   * inside `Pages`. Each row counts independently for keyboard nav
   * (`pageIndexToRowIndex` walks duplicates), so arrow-down through a
   * starred-and-namespaced duplicate naturally walks past the same
   * page twice. Star toggle from either copy updates `starredIds` via
   * `useStarredPages` and both rows refresh immediately.
   *
   * Sentinel header rows are interleaved only at render time. The
   * single-page-vault branch is preserved (1 page → no chrome at all).
   */
  // Whether ANY page in the unfiltered set is namespaced. Used only
  // to decide whether to take the single-page-vault shortcut. Pulled
  // out so the grouping memo below doesn't read `pages` directly
  // (keeps its dependency surface tight and lets biome's
  // useExhaustiveDependencies trace stay clean).
  const hasAnyNamespacedPage = useMemo(
    () => pages.some((p) => (p.content ?? '').includes('/')),
    [pages],
  )
  const isSinglePageVault = pages.length <= 1 && !hasAnyNamespacedPage

  const { filteredPages, groupedRows, pageIndexToRowIndex, hasStarred, hasPages } = useMemo(() => {
    // `starredIds` is sourced from `useStarredPages()` and changes
    // whenever a star toggle happens (in this view or another mounted
    // hook instance), so pages move between sections immediately.
    return isSinglePageVault
      ? buildSinglePageBranch(filteredPagesUnsorted, sortPages)
      : buildMultiPageBranch(filteredPagesUnsorted, sortPages, sortOption, starredIds)
  }, [isSinglePageVault, filteredPagesUnsorted, sortPages, sortOption, starredIds])

  const virtualItemCount = groupedRows.length

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredPages.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const page = filteredPages[idx]
      if (page) onPageSelect?.(page.id, page.content ?? undefined)
    },
  })

  // Reset focusedIndex when filter/sort changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterText and sortOption intentionally trigger reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [filterText, sortOption, setFocusedIndex])

  const virtualizer = useVirtualizer({
    count: virtualItemCount,
    getScrollElement: () => listRef.current,
    // Header rows (~36px) sentinel-interspersed between page rows
    // (~44px) and tree-page rows (~44px for the root; descendants
    // render inside the same DOM wrapper).
    estimateSize: (index) => {
      const row = groupedRows[index]
      if (row?.kind === 'header') return HEADER_ROW_HEIGHT
      // Both `page` and `tree-page` share the 44px row height. The
      // virtualizer's `measureElement` ref handler later corrects to
      // actual height when descendants expand the wrapper.
      return PAGE_ROW_HEIGHT
    },
    overscan: 5,
  })

  // Document-level keydown: skip if user is typing in input/select/textarea
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown])

  // Scroll focused item into view. `focusedIndex` indexes into the
  // page-only `filteredPages` array; sentinel headers shift the row
  // index in the virtualizer, so map through `pageIndexToRowIndex`.
  useEffect(() => {
    if (focusedIndex < 0) return
    const rowIndex = pageIndexToRowIndex[focusedIndex] ?? focusedIndex
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [focusedIndex, virtualizer, pageIndexToRowIndex])

  const isFiltering = filterText.trim().length > 0

  // Row renderers extracted from the virtualizer map to keep the JSX
  // body's cognitive complexity below biome's threshold. Each renderer
  // closes over the component's state — they're not pure functions, just
  // a structural split.
  const rowStyle = (start: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    transform: `translateY(${start}px)`,
  })

  const renderTreePageRow = (
    virtualRow: VirtualItem,
    row: Extract<PageBrowserRow, { kind: 'tree-page' }>,
  ): React.ReactElement => {
    const { node, pageIndex, depth } = row
    // Tree-page rows wrap a recursive `PageTreeItem` whose own
    // buttons handle activation/expand. The wrapper itself is NOT a
    // listbox `option` (we'd violate the listbox-with-options pattern
    // by nesting button rows underneath it). For keyboard-nav
    // visibility we apply a focus ring on the wrapper when the row
    // is the focused page index — `aria-selected` is intentionally
    // omitted here because it is only meaningful on `role="option"`.
    return (
      <div
        key={virtualRow.key}
        data-index={virtualRow.index}
        ref={virtualizer.measureElement}
        data-page-tree-row
        data-page-index={pageIndex}
        className={cn(
          focusedIndex === pageIndex && 'rounded-lg ring-2 ring-inset ring-ring/50 bg-accent/30',
        )}
        style={rowStyle(virtualRow.start)}
      >
        <PageTreeItem
          node={node}
          depth={depth}
          onNavigate={(pageId, title) => onPageSelect?.(pageId, title)}
          onCreateUnder={handleCreateUnder}
          filterText={filterText.trim()}
          forceExpand={isFiltering}
          onDelete={(id, name) => setDeleteTarget({ id, name })}
        />
      </div>
    )
  }

  const renderHeaderRow = (
    virtualRow: VirtualItem,
    row: Extract<PageBrowserRow, { kind: 'header' }>,
  ): React.ReactElement => {
    const isStarredHeader = row.section === 'starred'
    const visibleLabel = isStarredHeader
      ? t('pageBrowser.starredSection')
      : t('pageBrowser.pagesSection')
    const accessibleLabel = isStarredHeader
      ? t('pageBrowser.starredSectionLabel', { count: row.count })
      : t('pageBrowser.pagesSectionLabel', { count: row.count })
    const labelId = `${sectionLabelId}-${row.section}`
    // The `Pages` header gets a thin top divider when it follows the
    // `Starred` section, separating the two groups visually without
    // an extra DOM node.
    const showDivider = !isStarredHeader && hasStarred
    return (
      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA listbox-with-groups pattern (`<fieldset>` is a form-control container — wrong semantics inside `role="listbox"`)
      <div
        key={virtualRow.key}
        data-index={virtualRow.index}
        ref={virtualizer.measureElement}
        data-page-section={row.section}
        role="group"
        aria-labelledby={labelId}
        className={cn(
          'page-browser-section flex items-center gap-2 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
          showDivider && 'border-t border-border mt-1',
        )}
        style={rowStyle(virtualRow.start)}
      >
        {isStarredHeader ? (
          <Star className="h-3.5 w-3.5 text-star" aria-hidden="true" fill="currentColor" />
        ) : (
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span id={labelId} className="sr-only">
          {accessibleLabel}
        </span>
        <span aria-hidden="true">{visibleLabel}</span>
        <span aria-hidden="true" className="ml-1 font-normal text-muted-foreground/80">
          {row.count}
        </span>
      </div>
    )
  }

  const renderPageRow = (
    virtualRow: VirtualItem,
    row: Extract<PageBrowserRow, { kind: 'page' }>,
  ): React.ReactElement => {
    const { page, pageIndex } = row
    const pageStarred = isStarred(page.id)
    const title = page.content ?? t('pageBrowser.untitled')
    const trimmedFilter = filterText.trim()
    const showAliasBadge =
      aliasMatchId === page.id &&
      trimmedFilter !== '' &&
      !matchesSearchFolded(page.content ?? '', trimmedFilter)
    return (
      <div
        key={virtualRow.key}
        data-index={virtualRow.index}
        ref={virtualizer.measureElement}
        role="option"
        aria-selected={focusedIndex === pageIndex}
        data-page-item
        data-starred={pageStarred}
        tabIndex={-1}
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
          // Row-highlight (background) only — the inner button paints its own
          // `focus-visible:ring-[3px]` ring for the actual focus affordance.
          // Painting a ring here as well stacked two rings on the focused row.
          focusedIndex === pageIndex && 'bg-accent/30',
        )}
        style={rowStyle(virtualRow.start)}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={pageStarred ? t('pageBrowser.unstarPage') : t('pageBrowser.starPage')}
          className="star-toggle shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
          data-starred={pageStarred}
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(page.id)
          }}
        >
          <Star className="h-3.5 w-3.5" fill={pageStarred ? 'currentColor' : 'none'} />
        </Button>
        <button
          type="button"
          className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-hidden"
          onClick={() => onPageSelect?.(page.id, title)}
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="page-browser-item-title truncate" title={title}>
            <HighlightMatch text={title} filterText={trimmedFilter} />
            {showAliasBadge && (
              <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
            )}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('pageBrowser.deleteButton')}
          className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
          disabled={deletingId === page.id}
          onClick={(e) => {
            e.stopPropagation()
            setDeleteTarget({ id: page.id, name: title })
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="page-browser space-y-4">
      <ViewHeader>
        <div className="page-browser-header space-y-2">
          {/* Create page form */}
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault()
              handleCreatePage()
            }}
            className="flex flex-col sm:flex-row sm:items-center gap-2"
          >
            <Label htmlFor="new-page-name" className="sr-only">
              {t('pageBrowser.createPageInputLabel')}
            </Label>
            <SearchInput
              ref={newPageInputRef}
              id="new-page-name"
              value={newPageName}
              onChange={(e) => setNewPageName(e.target.value)}
              placeholder={t('pageBrowser.newPagePlaceholder')}
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={isCreating || !newPageName.trim()}>
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.newPage')}
            </Button>
          </form>

          {/* Search/filter input + sort dropdown */}
          {pages.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <SearchInput
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('pageBrowser.searchPlaceholder')}
                  className="pl-8"
                  aria-label={t('pageBrowser.searchPlaceholder')}
                />
              </div>
              <Select value={sortOption} onValueChange={(v) => handleSortChange(v as SortOption)}>
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-[7rem]"
                  aria-label={t('pageBrowser.sortLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alphabetical">{t('pageBrowser.sortAlphabetical')}</SelectItem>
                  <SelectItem value="recent">{t('pageBrowser.sortRecent')}</SelectItem>
                  <SelectItem value="created">{t('pageBrowser.sortCreated')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </ViewHeader>

      {(!spaceIsReady || (loading && pages.length === 0)) && (
        <div aria-busy="true">
          <LoadingSkeleton count={3} height="h-10" className="page-browser-loading" />
        </div>
      )}

      {spaceIsReady && !loading && pages.length === 0 && (
        <EmptyState
          icon={FileText}
          message={t('pageBrowser.noPages')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={handleCreatePage}
              disabled={isCreating}
            >
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.createFirst')}
            </Button>
          }
        />
      )}

      <ScrollArea
        viewportRef={listRef}
        className="page-browser-list max-h-[calc(100dvh-200px)]"
        viewportProps={{
          role: 'listbox',
          tabIndex: 0,
          'aria-label': hasStarred ? t('pageBrowser.pageListGrouped') : t('pageBrowser.pageList'),
          // Section presence flags exposed for tests / styling hooks.
          // FEAT-14 — the unified model means either or both can be
          // present independently; consumers that want section-aware
          // chrome key off these data attributes.
          'data-has-starred': hasStarred ? 'true' : 'false',
          'data-has-pages': hasPages ? 'true' : 'false',
        }}
      >
        {isFiltering && filteredPages.length === 0 ? (
          <EmptyState icon={Search} message={t('pageBrowser.noMatches')} />
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = groupedRows[virtualRow.index]
              if (!row) return null
              if (row.kind === 'header') return renderHeaderRow(virtualRow, row)
              if (row.kind === 'tree-page') return renderTreePageRow(virtualRow, row)
              return renderPageRow(virtualRow, row)
            })}
          </div>
        )}
      </ScrollArea>

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="page-browser-load-more"
        label={t('pageBrowser.loadMore')}
        loadingLabel={t('pageBrowser.loading')}
      />

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('pageBrowser.deletePage')}
        description={t('pageBrowser.deleteDescription', { name: deleteTarget?.name })}
        cancelLabel={t('pageBrowser.cancel')}
        actionLabel={t('pageBrowser.delete')}
        actionVariant="destructive"
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
