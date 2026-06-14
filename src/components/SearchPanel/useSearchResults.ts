/**
 * useSearchResults — the SearchPanel results pipeline.
 *
 * PEND-58g FE-A18 (continues FE-9) — extracted from the SearchPanel
 * god-component. Owns the AST→IPC projection, the paginated `searchBlocks`
 * query, the inline regex-error derive, breadcrumb (page-title)
 * resolution, page grouping + collapse state, the roving keyboard-nav
 * model, and result/recent-page navigation. Behaviour-preserving lift:
 * every memo/effect dependency array and the comments that justify them
 * are unchanged from the inline version.
 */
import type React from 'react'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { PAGINATION_LIMIT } from '@/lib/constants'
import { notify } from '@/lib/notify'
import { astToFilterProjection, type SearchQueryAST } from '@/lib/search-query'
import { parseValidationReason, ValidationCode } from '@/lib/search-query/validation-codes'

import { useListKeyboardNavigation } from '../../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery'
import { logger } from '../../lib/logger'
import { reportIpcError } from '../../lib/report-ipc-error'
import type { BlockRow, SearchBlockRow } from '../../lib/tauri'
import { batchResolve, getBlock, searchBlocks } from '../../lib/tauri'
import {
  type RecentPage,
  selectRecentPagesForSpace,
  toRecentPage,
  useRecentPagesStore,
} from '../../stores/recent-pages'
import { useTabsStore } from '../../stores/tabs'
import { groupResultsByPage, type SearchResultGroup } from '../search/SearchResultGroups'
import type { SearchToggleState } from '../search/SearchToggleRow'
import { astFilterParams } from './searchFilterParams'
import { useTagResolution } from './useTagResolution'

export interface UseSearchResultsOptions {
  /** The debounced query parsed to an AST (free text + structural filters). */
  debouncedAst: SearchQueryAST
  /** The debounced query string — drives the collapse / focus reset keys. */
  debouncedQuery: string
  currentSpaceId: string | null
  spaceIsReady: boolean
  toggles: SearchToggleState
}

export interface UseSearchResultsValue {
  results: SearchBlockRow[]
  searchLoading: boolean
  hasMore: boolean
  loadMore: () => void
  error: string | null
  capped: boolean
  setItems: Dispatch<SetStateAction<SearchBlockRow[]>>
  regexError: string | null
  groups: SearchResultGroup[]
  visibleRows: SearchBlockRow[]
  focusedIndex: number
  handleListKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => boolean
  expandedGroups: Record<string, boolean>
  handleToggleGroup: (pageId: string) => void
  handleResultClick: (block: BlockRow | SearchBlockRow) => Promise<void>
  loadingResultId: string | null
  recentPages: RecentPage[]
  handleRecentClick: (page: RecentPage) => void
}

export function useSearchResults({
  debouncedAst,
  debouncedQuery,
  currentSpaceId,
  spaceIsReady,
  toggles,
}: UseSearchResultsOptions): UseSearchResultsValue {
  const { t } = useTranslation()
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  // #1149 — recent pages now come from the reactive zustand store (single
  // source of truth, shared with QuickAccessBar/CommandPalette). The
  // mount-time `getRecentPages()` localStorage seed is gone: the selector
  // re-renders on every `addRecentPage` so the list is always live.
  const addRecentPage = useRecentPagesStore((s) => s.addRecentPage)
  const recentPageRefs = useRecentPagesStore((s) => selectRecentPagesForSpace(s, currentSpaceId))
  const recentPages: RecentPage[] = recentPageRefs.map(toRecentPage)

  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const debouncedProjection = useMemo(() => astToFilterProjection(debouncedAst), [debouncedAst])
  // FE-9 — tag name→id resolution (prefix lookup; FE-5 space-scoped cache
  // invalidation lives in the hook). #717 — `pending` gates the query below
  // so the first debounced search can't fire before resolution settles and
  // flash unfiltered results; a settled-but-unresolved name makes
  // `astFilterParams` project the matches-nothing sentinel.
  const { tagIds, pending: tagResolutionPending } = useTagResolution(
    debouncedProjection.tagNames,
    currentSpaceId,
  )

  // DSL-A8 / UX-A4 — the two search modes are symmetric. In BOTH modes the
  // structural filters are projected and applied as SQL filters server-side;
  // the only difference is the `isRegex` flag and how the backend interprets
  // the free-text remainder.
  const filterParams = useMemo(
    () => astFilterParams(debouncedProjection, tagIds),
    [debouncedProjection, tagIds],
  )
  const queryFn = useCallback(
    // FE-2 — forward the AbortSignal so a superseded search is cancelled
    // mid-flight instead of running the backend scan to completion.
    (cursor?: string, signal?: AbortSignal) =>
      // FEAT-3 Phase 4 — `searchBlocks` requires `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: empty string forces
      // a no-match SQL filter (returning empty results) rather than a runtime
      // null deref.
      searchBlocks(
        {
          query: debouncedAst.freeText,
          ...filterParams,
          cursor,
          limit: PAGINATION_LIMIT,
          spaceId: currentSpaceId ?? '',
          caseSensitive: toggles.caseSensitive,
          wholeWord: toggles.wholeWord,
          isRegex: toggles.isRegex,
        },
        signal,
      ),
    [
      debouncedAst.freeText,
      filterParams,
      currentSpaceId,
      toggles.caseSensitive,
      toggles.wholeWord,
      toggles.isRegex,
    ],
  )

  const {
    items: results,
    loading: searchLoading,
    hasMore,
    loadMore,
    error,
    capped,
    setItems,
  } = usePaginatedQuery(queryFn, {
    // PEND-54 / DSL-A8 / PEND-58g NEW-3 — fire when there is a free-text
    // pattern OR at least one structural filter (filter-only search).
    // #717 — HOLD while tag name→id resolution is in flight: firing now
    // would send the query without the tag constraint (transient
    // unfiltered flash, replaced when resolution settles).
    enabled:
      spaceIsReady &&
      !tagResolutionPending &&
      (debouncedAst.freeText.length > 0 || debouncedAst.filters.length > 0),
    // E2E-2 — do NOT pass `onError`; SearchPanel parses the `InvalidRegex:`
    // prefix off the raw IPC message via `regexError` below.
  })

  // PEND-55 / UX-A2 — parse `AppError::Validation("InvalidRegex: …")` off the
  // raw IPC error and surface it inline. Derived synchronously (not via an
  // effect) so the status region's generic-error suppression is single-commit.
  const regexError = useMemo<string | null>(() => {
    // PEND-70 CR11 — the inline regex alert is regex-mode-only. In
    // case-sensitive / whole-word mode the backend builds a *literal* match
    // regex internally; an oversized literal makes `build_regex` reject with an
    // `InvalidRegex:`-prefixed error. Surfacing that as "invalid regex" to a
    // user who never enabled regex is misleading — fall through to the generic
    // error state instead by short-circuiting here.
    if (!toggles.isRegex) return null
    if (!error) return null
    const msg = typeof error === 'string' ? error : ''
    // #1061 — match on the shared `ValidationCode.InvalidRegex` constant
    // (single source of truth in `validation-codes.ts`) instead of a raw
    // `'InvalidRegex:'` literal.
    const reason = parseValidationReason(msg, ValidationCode.InvalidRegex)
    if (reason === null) return null
    return t('search.invalidRegex', { message: reason })
  }, [error, t, toggles.isRegex])

  // Issue #153 — every page_id ever fed into `batchResolve` for
  // breadcrumb resolution, regardless of outcome. The breadcrumb
  // `useEffect` below consults this ref before assembling the next
  // batch, so a permanently-unresolvable id (soft-deleted parent,
  // missing page) costs exactly one IPC for the life of the hook.
  const attemptedBreadcrumbIdsRef = useRef<Set<string>>(new Set<string>())

  // Resolve page titles for breadcrumbs when results change.
  //
  // Issue #153 — unresolvable page_ids (soft-deleted, missing) never
  // land in `pageTitles`, so without `attemptedBreadcrumbIdsRef` the
  // `!pageTitles.has(id)` filter below would re-fire `batchResolve` for
  // them on every `loadMore`.
  useEffect(() => {
    // FE-11 — only resolve page ids we haven't already resolved or
    // already attempted (#153).
    const parentIds = [
      ...new Set(results.map((b) => b.page_id).filter((id): id is string => id != null)),
    ].filter((id) => !pageTitles.has(id) && !attemptedBreadcrumbIdsRef.current.has(id))
    if (parentIds.length === 0) return
    // Record the attempt up front so a rejected promise (or a resolved
    // result that omits some ids) cannot cause a re-fire on the next
    // `loadMore`.
    for (const id of parentIds) attemptedBreadcrumbIdsRef.current.add(id)
    batchResolve(parentIds)
      .then((resolved) => {
        if (Array.isArray(resolved)) {
          setPageTitles((prev) => {
            // PEND-73 Phase 4.P2 — stabilise Map identity so the
            // `groupResultsByPage` memo doesn't invalidate on every
            // batchResolve fetch. Only allocate a new Map if a title changed.
            let changed = false
            for (const r of resolved) {
              const nextTitle = r.title ?? 'Untitled'
              if (prev.get(r.id) !== nextTitle) {
                changed = true
                break
              }
            }
            if (!changed) return prev
            const next = new Map(prev)
            for (const r of resolved) {
              next.set(r.id, r.title ?? 'Untitled')
            }
            return next
          })
        } else {
          logger.warn('SearchPanel', 'breadcrumb resolve returned a non-array result', undefined)
        }
      })
      .catch((err) => {
        logger.warn('SearchPanel', 'breadcrumb resolution failed', undefined, err)
      })
    // `pageTitles` participates so the already-resolved filter above sees the
    // latest map; the empty-`parentIds` guard makes the follow-up a no-op.
  }, [results, pageTitles])

  // FE-4 — a monotonic "navigation generation". Each click claims the next
  // generation; only the latest may resolve the spinner / perform the
  // deferred navigation.
  const navGenerationRef = useRef(0)
  const handleResultClick = useCallback(
    async (block: BlockRow | SearchBlockRow) => {
      const gen = ++navGenerationRef.current
      setLoadingResultId(block.id)
      try {
        if (block.block_type === 'page') {
          addRecentPage(block.id, block.content ?? 'Untitled')
          navigateToPage(block.id, block.content ?? 'Untitled')
          return
        }
        if (block.parent_id) {
          try {
            const parent = await getBlock(block.parent_id)
            // A newer click superseded this one while the parent loaded.
            if (navGenerationRef.current !== gen) return
            addRecentPage(block.parent_id, parent.content ?? 'Untitled')
            navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
          } catch (err) {
            reportIpcError('SearchPanel', 'search.loadResultsFailed', err, t, {
              blockId: block.id,
              parentId: block.parent_id,
            })
          }
        } else {
          logger.warn('SearchPanel', 'block has no parent page', { blockId: block.id })
          notify.error(t('search.noParentPage'))
        }
      } finally {
        // Only the latest click owns the spinner.
        if (navGenerationRef.current === gen) setLoadingResultId(null)
      }
    },
    [addRecentPage, navigateToPage, t],
  )

  // PEND-50 Phase 1 — page-group results. Groups are derived from the flat
  // list each render; their expand state lives in `expandedGroups` so it
  // persists across re-renders but resets on a new query (effect below).
  const groups = useMemo(() => groupResultsByPage(results, pageTitles), [results, pageTitles])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const handleToggleGroup = useCallback((pageId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [pageId]: !(prev[pageId] ?? true) }))
  }, [])
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `debouncedQuery` is the trigger, not a body-read dep — we intentionally reset on every new query.
  useEffect(() => {
    // Reset collapse state on each new query so the UX always starts
    // fully expanded.
    setExpandedGroups({})
  }, [debouncedQuery])

  // PEND-50 Phase 1 — flatten visible (expanded) rows for the keyboard nav
  // hook. Collapsed groups contribute zero rows.
  const visibleRows = useMemo(() => {
    const out: SearchBlockRow[] = []
    for (const g of groups) {
      const isExpanded = expandedGroups[g.page_id] ?? true
      if (!isExpanded) continue
      for (const block of g.blocks) out.push(block)
    }
    return out
  }, [groups, expandedGroups])

  const { focusedIndex, handleKeyDown: handleListKeyDown } = useListKeyboardNavigation({
    itemCount: visibleRows.length,
    // FE-A8 — `debouncedQuery` is the query-change signal: a new query resets
    // focus to row 0, but a plain `itemCount` change clamps the existing focus.
    resetKey: debouncedQuery,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = visibleRows[idx]
      if (block) handleResultClick(block)
    },
  })

  const handleRecentClick = useCallback(
    (page: RecentPage) => {
      addRecentPage(page.id, page.title)
      navigateToPage(page.id, page.title)
    },
    [addRecentPage, navigateToPage],
  )

  return {
    results,
    searchLoading,
    hasMore,
    loadMore,
    error,
    capped,
    setItems,
    regexError,
    groups,
    visibleRows,
    focusedIndex,
    handleListKeyDown,
    expandedGroups,
    handleToggleGroup,
    handleResultClick,
    loadingResultId,
    recentPages,
    handleRecentClick,
  }
}
