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
import { useListKeyboardNavigation } from '../../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery'
import { logger } from '../../lib/logger'
import { addRecentPage, getRecentPages, type RecentPage } from '../../lib/recent-pages'
import { reportIpcError } from '../../lib/report-ipc-error'
import type { BlockRow, SearchBlockRow } from '../../lib/tauri'
import { batchResolve, getBlock, searchBlocks } from '../../lib/tauri'
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

  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [recentPages, setRecentPages] = useState<RecentPage[]>([])

  // Load recent pages from localStorage on mount.
  useEffect(() => {
    setRecentPages(getRecentPages())
  }, [])

  const debouncedProjection = useMemo(() => astToFilterProjection(debouncedAst), [debouncedAst])
  // FE-9 — tag name→id resolution (best-effort prefix lookup; FE-5
  // space-scoped cache invalidation lives in the hook).
  const tagIds = useTagResolution(debouncedProjection.tagNames, currentSpaceId)

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
    enabled: spaceIsReady && (debouncedAst.freeText.length > 0 || debouncedAst.filters.length > 0),
    // E2E-2 — do NOT pass `onError`; SearchPanel parses the `InvalidRegex:`
    // prefix off the raw IPC message via `regexError` below.
  })

  // PEND-55 / UX-A2 — parse `AppError::Validation("InvalidRegex: …")` off the
  // raw IPC error and surface it inline. Derived synchronously (not via an
  // effect) so the status region's generic-error suppression is single-commit.
  const regexError = useMemo<string | null>(() => {
    if (!error) return null
    const msg = typeof error === 'string' ? error : ''
    const prefix = 'InvalidRegex:'
    const idx = msg.indexOf(prefix)
    if (idx < 0) return null
    return t('search.invalidRegex', { message: msg.slice(idx + prefix.length).trim() })
  }, [error, t])

  // Resolve page titles for breadcrumbs when results change.
  useEffect(() => {
    // FE-11 — only resolve page ids we haven't already resolved.
    const parentIds = [
      ...new Set(results.map((b) => b.page_id).filter((id): id is string => id != null)),
    ].filter((id) => !pageTitles.has(id))
    if (parentIds.length === 0) return
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
          setRecentPages(getRecentPages())
          navigateToPage(block.id, block.content ?? 'Untitled')
          return
        }
        if (block.parent_id) {
          try {
            const parent = await getBlock(block.parent_id)
            // A newer click superseded this one while the parent loaded.
            if (navGenerationRef.current !== gen) return
            addRecentPage(block.parent_id, parent.content ?? 'Untitled')
            setRecentPages(getRecentPages())
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
    [navigateToPage, t],
  )

  // PEND-50 Phase 1 — page-group results. Groups are derived from the flat
  // list each render; their expand state lives in `expandedGroups` so it
  // persists across re-renders but resets on a new query (effect below).
  const groups = useMemo(() => groupResultsByPage(results, pageTitles), [results, pageTitles])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const handleToggleGroup = useCallback((pageId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [pageId]: !(prev[pageId] ?? true) }))
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `debouncedQuery` is the trigger, not a body-read dep — we intentionally reset on every new query.
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
      setRecentPages(getRecentPages())
      navigateToPage(page.id, page.title)
    },
    [navigateToPage],
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
