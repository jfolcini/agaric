/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination (`t('search.loadMoreButton')`) via usePaginatedQuery
 *  - CJK limitation notice (p3-t6)
 *
 * Opened via Ctrl+F (see `App.tsx` global handler around line 712, the
 * `focusSearch` `matchesShortcutBinding` branch — UX-260 sub-fix 6).
 *
 * PEND-30 D-3 — state-heavy logic decomposed into siblings under
 * `./SearchPanel/`:
 *  - `searchFilterReducer.ts` collapses the four applied-filter
 *    `useState`s into a single typed reducer.
 *  - `usePopoverEntity.ts` factors the page- and tag-popover state
 *    machines (4 useStates each) behind one parameterised hook.
 *  - `useAliasResolution.ts` owns the `[[alias]]` resolution effect.
 *
 * PEND-30 Phase 3b — JSX presentation lifted into siblings under
 * `./SearchPanel/`:
 *  - `SearchHeader.tsx` owns the input form + activity indicators.
 *  - `SearchFilters.tsx` owns the filter chip bar + popovers.
 *  - `SearchResultList.tsx` owns the listbox of result rows.
 *  - `SearchStatusRegion.tsx` owns the aria-live status announcer.
 */

import { Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { LoadMoreButton } from '@/components/LoadMoreButton'
import { CardButton } from '@/components/ui/card-button'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { notify } from '@/lib/notify'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { logger } from '../lib/logger'
import { addRecentPage, getRecentPages, type RecentPage } from '../lib/recent-pages'
import { reportIpcError } from '../lib/report-ipc-error'
import type { BlockRow, TagCacheRow } from '../lib/tauri'
import {
  batchResolve,
  getBlock,
  listAllPagesInSpace,
  listTagsByPrefix,
  paginationLimit,
  searchBlocks,
} from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { useTabsStore } from '../stores/tabs'
import { EmptyState } from './EmptyState'
import { ResultCard } from './ResultCard'
import { SearchFilters } from './SearchPanel/SearchFilters'
import { SearchHeader } from './SearchPanel/SearchHeader'
import { SearchResultList } from './SearchPanel/SearchResultList'
import { SearchStatusRegion } from './SearchPanel/SearchStatusRegion'
import { INITIAL_SEARCH_FILTER_STATE, searchFilterReducer } from './SearchPanel/searchFilterReducer'
import { useAliasResolution } from './SearchPanel/useAliasResolution'
import { usePopoverEntity } from './SearchPanel/usePopoverEntity'

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

export function SearchPanel(): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — scope search to the current space. Mirrors the
  // `PageBrowser` pattern: render a `LoadingSkeleton` until the
  // `SpaceStore` has hydrated so the first `searchBlocks` call never
  // leaks cross-space results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searched, setSearched] = useState(false)
  // UX-335 — `cleared` is true iff the user emptied the search input AFTER a
  // search had been performed. Used to surface a `t('search.statusCleared')`
  // announcement in the aria-live status region (separate from pre-search).
  const [cleared, setCleared] = useState(false)
  const [typing, setTyping] = useState(false)
  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [recentPages, setRecentPages] = useState<RecentPage[]>([])
  const navigateToPage = useTabsStore((s) => s.navigateToPage)

  // PEND-30 D-3 — applied-filter state moved to a typed reducer.
  const [filterState, dispatchFilter] = useReducer(searchFilterReducer, INITIAL_SEARCH_FILTER_STATE)
  const { filterPageId, filterTagIds } = filterState

  // PEND-30 D-3 / limit-clamp-followup row `SearchPanel.tsx:138` —
  // page picker: scoped to the current space. Mirrors the
  // `useBlockResolve.searchPages` dispatcher precedent (short vs long
  // query branches) so the picker can find pages past the previous
  // hardcoded 20-row clamp.
  //
  //  - Short queries (≤2 chars): `list_all_pages_in_space` returns the
  //    full unbounded set of pages (no pagination, no clamp). We
  //    project the `PageHeading` rows into the `BlockRow` shape the
  //    popover renderer expects (only `id`/`content` are read
  //    downstream — see `renderItem`/`keyExtractor`/`handleSelectPage`
  //    below — so the remaining `BlockRow` fields are stub values
  //    sufficient to satisfy the type). UX-248 Unicode-aware folding
  //    (`matchesSearchFolded`) still runs client-side for `İstanbul`
  //    ↔ `istanbul` parity with PageBrowser and HighlightMatch.
  //  - Long queries (>2 chars): `searchBlocks` (FTS5) returns
  //    relevance-ranked results filtered to `block_type === 'page'`.
  //    FTS5 has its own tokenizer so we drop the JS folding here.
  const pagePopover = usePopoverEntity<BlockRow>({
    logLabel: 'page',
    extraDeps: [currentSpaceId],
    searchFn: async (q) => {
      const trimmed = q.trim()
      // FEAT-3 Phase 4 — both IPCs require `spaceId`. `?? ''` is
      // the pre-bootstrap no-match fallback (see SearchPanel main
      // `queryFn`).
      const spaceId = currentSpaceId ?? ''
      if (trimmed.length <= 2) {
        const pages = await listAllPagesInSpace(spaceId)
        const projected: BlockRow[] = pages.map((p) => ({
          id: p.id,
          block_type: 'page',
          content: p.content,
          parent_id: null,
          position: null,
          deleted_at: null,
          todo_state: p.todo_state,
          priority: p.priority,
          due_date: p.due_date,
          scheduled_date: p.scheduled_date,
          page_id: null,
        }))
        return trimmed
          ? projected.filter((b) => matchesSearchFolded(b.content ?? '', trimmed))
          : projected
      }
      const res = await searchBlocks({
        query: trimmed,
        limit: paginationLimit(20),
        spaceId,
      })
      return res.items.filter((b) => b.block_type === 'page')
    },
  })

  // PEND-30 D-3 — tag picker: server-side prefix matching, no extra deps.
  const tagPopover = usePopoverEntity<TagCacheRow>({
    logLabel: 'tag',
    searchFn: (q) => listTagsByPrefix({ prefix: q, limit: paginationLimit(20) }),
  })

  // Load recent pages from localStorage on mount
  useEffect(() => {
    setRecentPages(getRecentPages())
  }, [])

  const queryFn = useCallback(
    (cursor?: string) =>
      // FEAT-3 Phase 4 — `searchBlocks` requires `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: empty string
      // forces a no-match SQL filter (returning empty results) rather
      // than a runtime null deref. The `enabled: spaceIsReady` gate
      // below normally prevents this branch from firing.
      searchBlocks({
        query: debouncedQuery,
        parentId: filterPageId ?? undefined,
        tagIds: filterTagIds.length > 0 ? filterTagIds : undefined,
        cursor,
        limit: PAGINATION_LIMIT,
        spaceId: currentSpaceId ?? '',
      }),
    [debouncedQuery, filterPageId, filterTagIds, currentSpaceId],
  )

  const {
    items: results,
    loading: searchLoading,
    hasMore,
    loadMore,
    error,
    setItems,
  } = usePaginatedQuery(queryFn, {
    enabled: spaceIsReady && debouncedQuery.length > 0,
    onError: t('search.failed'),
  })

  // Resolve page titles for breadcrumbs when results change
  useEffect(() => {
    const parentIds = [
      ...new Set(results.map((b) => b.page_id).filter((id): id is string => id != null)),
    ]
    if (parentIds.length === 0) return
    batchResolve(parentIds)
      .then((resolved) => {
        if (Array.isArray(resolved)) {
          setPageTitles((prev) => {
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
  }, [results])

  // PEND-30 D-3 — alias resolution lifted into its own hook.
  const { aliasMatch, aliasQuery } = useAliasResolution(debouncedQuery, results, currentSpaceId)

  const debounced = useDebouncedCallback((value: string) => {
    setTyping(false)
    setDebouncedQuery(value)
    setSearched(true)
  }, 300)

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)

    debounced.cancel()

    if (!value.trim()) {
      // UX-335 — if a search had been performed (or we were already in the
      // cleared state and somehow re-emptied), keep `cleared` set so the
      // aria-live region announces `t('search.statusCleared')`.
      setCleared((prev) => prev || searched)
      setDebouncedQuery('')
      setItems([])
      setSearched(false)
      setTyping(false)
      // Alias state clears automatically: `useAliasResolution` re-runs
      // when `debouncedQuery` becomes '' and resets the match.
      return
    }

    setCleared(false)
    setTyping(true)
    debounced.schedule(value)
  }

  // Auto-focus search input on mount
  const searchInputRef = useRef<HTMLInputElement>(null)
  useRegisterPrimaryFocus(searchInputRef)
  useEffect(() => {
    searchInputRef.current?.focus()
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    debounced.cancel()
    setTyping(false)
    if (query.trim()) {
      setDebouncedQuery(query.trim())
      setSearched(true)
    }
  }

  const handleResultClick = useCallback(
    async (block: BlockRow) => {
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
        setLoadingResultId(null)
      }
    },
    [navigateToPage, t],
  )

  const { focusedIndex, handleKeyDown: handleListKeyDown } = useListKeyboardNavigation({
    itemCount: results.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = results[idx]
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

  function handleSelectPage(page: BlockRow) {
    dispatchFilter({
      type: 'set-page-filter',
      pageId: page.id,
      pageTitle: page.content ?? 'Untitled',
    })
    pagePopover.reset()
  }

  function handleSelectTag(tag: TagCacheRow) {
    dispatchFilter({ type: 'add-tag-filter', tagId: tag.tag_id, tagName: tag.name })
    tagPopover.reset()
  }

  // FEAT-3 Phase 2 — render a skeleton while the SpaceStore hydrates so
  // we never fire a `searchBlocks` call with an unresolved `spaceId`.
  if (!spaceIsReady) {
    return (
      <div className="search-panel space-y-4" aria-busy="true">
        <LoadingSkeleton count={3} height="h-10" className="search-panel-loading" />
      </div>
    )
  }

  return (
    <div className="search-panel space-y-4">
      {/* PEND-30 Phase 3b — input form lifted into `SearchHeader`. */}
      <SearchHeader
        inputRef={searchInputRef}
        query={query}
        onInputChange={handleInputChange}
        onSubmit={handleSubmit}
        searchLoading={searchLoading}
        typing={typing}
        t={t}
      />

      {/* UX-269 — CJK limitation notice sits directly below the input so
          CJK users see it before scanning results. */}
      {hasCJK(query) && (
        <div
          className="rounded-lg border border-alert-info-border bg-alert-info p-3 text-sm text-alert-info-foreground"
          data-testid="cjk-notice"
        >
          <span className="font-medium">{t('search.cjkNoteLabel')}</span>{' '}
          {t('search.cjkLimitationNote')}
        </div>
      )}

      {/* PEND-30 Phase 3b — chip bar lifted into `SearchFilters`. */}
      <SearchFilters
        filterState={filterState}
        dispatchFilter={dispatchFilter}
        pagePopover={pagePopover}
        tagPopover={tagPopover}
        onSelectPage={handleSelectPage}
        onSelectTag={handleSelectTag}
        t={t}
      />

      {query.trim().length > 0 && query.trim().length < 3 && (
        <div className="rounded-lg border border-alert-warning-border bg-alert-warning p-3 text-sm text-alert-warning-foreground">
          {t('search.minCharsHint')}
        </div>
      )}

      {query === '' && recentPages.length > 0 && (
        <div className="recent-pages">
          <h3 className="text-sm font-medium text-muted-foreground px-3 py-2">
            {t('search.recentTitle')}
          </h3>
          <ul className="space-y-1 list-none m-0 p-0">
            {recentPages.map((page) => (
              <li key={page.id}>
                <CardButton className="text-sm" onClick={() => handleRecentClick(page)}>
                  {page.title}
                </CardButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      {searchLoading && results.length === 0 && (
        <LoadingSkeleton count={2} height="h-12" className="search-loading" />
      )}

      {/* PEND-30 Phase 3b — status region lifted into `SearchStatusRegion`. */}
      <SearchStatusRegion
        searched={searched}
        searchLoading={searchLoading}
        error={error}
        cleared={cleared}
        resultCount={results.length}
        t={t}
      />

      {searched && !searchLoading && results.length === 0 && !error && !aliasMatch && (
        <EmptyState icon={Search} message={t('search.noResultsFound')} />
      )}

      {aliasMatch && (
        <div data-testid="alias-match">
          <ResultCard
            block={aliasMatch}
            onClick={() => handleResultClick(aliasMatch)}
            disabled={loadingResultId === aliasMatch.id}
            showSpinner={loadingResultId === aliasMatch.id}
            contentClassName="line-clamp-2"
          >
            <p className="text-xs text-muted-foreground mt-1" data-testid="alias-match-label">
              {t('search.aliasMatch', { alias: aliasQuery })}
            </p>
          </ResultCard>
        </div>
      )}

      {/* PEND-30 Phase 3b — listbox lifted into `SearchResultList`. */}
      <SearchResultList
        results={results}
        focusedIndex={focusedIndex}
        onKeyDown={handleListKeyDown}
        onResultClick={handleResultClick}
        loadingResultId={loadingResultId}
        pageTitles={pageTitles}
        t={t}
      />

      <LoadMoreButton
        hasMore={hasMore}
        loading={searchLoading}
        onLoadMore={loadMore}
        className="search-load-more"
      />
    </div>
  )
}
