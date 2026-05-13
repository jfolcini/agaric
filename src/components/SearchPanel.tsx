/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination ("Load more") via usePaginatedQuery
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
 */

import type { TFunction } from 'i18next'
import { Search, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { LoadMoreButton } from '@/components/LoadMoreButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardButton } from '@/components/ui/card-button'
import { SearchInput } from '@/components/ui/search-input'
import { Spinner } from '@/components/ui/spinner'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { cn } from '@/lib/utils'
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
  searchBlocks,
} from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { useTabsStore } from '../stores/tabs'
import { EmptyState } from './EmptyState'
import { PageLink } from './PageLink'
import { ResultCard } from './ResultCard'
import { SearchablePopover } from './SearchablePopover'
import {
  hasActiveFilters,
  INITIAL_SEARCH_FILTER_STATE,
  searchFilterReducer,
} from './SearchPanel/searchFilterReducer'
import { useAliasResolution } from './SearchPanel/useAliasResolution'
import { usePopoverEntity } from './SearchPanel/usePopoverEntity'
import { ViewHeader } from './ViewHeader'

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

/**
 * UX-335 — Compute the live-region status text for the search results
 * count. Extracted from SearchPanel JSX to keep the component under
 * Biome's cognitive-complexity ceiling. Returns `null` when the region
 * should stay empty (pre-search / loading).
 */
function getSearchStatusText(
  args: {
    searched: boolean
    searchLoading: boolean
    error: string | null
    cleared: boolean
    resultCount: number
  },
  t: TFunction,
): string | null {
  const { searched, searchLoading, error, cleared, resultCount } = args
  if (searched && !searchLoading && !error && resultCount > 0) {
    return t('search.resultsCount', { count: resultCount })
  }
  if (searched && !searchLoading && !error && resultCount === 0) {
    return t('search.statusNoResults')
  }
  if (cleared && !searchLoading) {
    return t('search.statusCleared')
  }
  return null
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
  // search had been performed. Used to surface a "Search cleared"
  // announcement in the aria-live status region (separate from pre-search).
  const [cleared, setCleared] = useState(false)
  const [typing, setTyping] = useState(false)
  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [recentPages, setRecentPages] = useState<RecentPage[]>([])
  const navigateToPage = useTabsStore((s) => s.navigateToPage)

  // PEND-30 D-3 — applied-filter state moved to a typed reducer.
  const [filterState, dispatchFilter] = useReducer(searchFilterReducer, INITIAL_SEARCH_FILTER_STATE)
  const { filterPageId, filterPageTitle, filterTagIds, filterTagNames } = filterState
  const hasFilters = hasActiveFilters(filterState)

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
        limit: 20,
        spaceId,
      })
      return res.items.filter((b) => b.block_type === 'page')
    },
  })

  // PEND-30 D-3 — tag picker: server-side prefix matching, no extra deps.
  const tagPopover = usePopoverEntity<TagCacheRow>({
    logLabel: 'tag',
    searchFn: (q) => listTagsByPrefix({ prefix: q, limit: 20 }),
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
      // aria-live region announces "Search cleared".
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
          toast.error(t('search.noParentPage'))
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
      <ViewHeader>
        {/* biome-ignore lint/a11y/useSemanticElements: jsdom doesn't support <search> element */}
        <form
          onSubmit={handleSubmit}
          role="search"
          className="search-panel-header flex flex-col sm:flex-row sm:items-center gap-2"
        >
          <SearchInput
            ref={searchInputRef}
            value={query}
            onChange={handleInputChange}
            placeholder={t('search.searchPlaceholder')}
            aria-label={t('search.searchLabel')}
            className="flex-1"
            autoFocus
          />
          <Button type="submit" variant="outline" disabled={!query.trim()}>
            {t('search.searchButton')}
          </Button>
          {searchLoading ? (
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="search-fetching-indicator"
            >
              <Spinner /> {t('search.searching')}
            </span>
          ) : typing ? (
            <span className="text-xs text-muted-foreground" data-testid="search-typing-indicator">
              {t('search.typing')}
            </span>
          ) : null}
        </form>
      </ViewHeader>

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

      {/* Filter chip bar */}
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset is for forms, not filter chip groups */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2',
          hasFilters && 'rounded-lg border border-primary/30 bg-primary/5 p-2',
        )}
        data-testid="filter-chip-bar"
        role="group"
        aria-label={t('search.filtersActive')}
      >
        {filterPageId && filterPageTitle && (
          <Badge variant="secondary" className="gap-1">
            {t('search.inPage', { name: filterPageTitle })}
            <button
              type="button"
              onClick={() => dispatchFilter({ type: 'clear-page-filter' })}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              aria-label={t('search.removePageFilter')}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}

        {filterTagNames.map((name, index) => (
          <Badge key={filterTagIds[index]} variant="secondary" className="gap-1">
            #{name}
            <button
              type="button"
              onClick={() => dispatchFilter({ type: 'remove-tag-filter', index })}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]"
              aria-label={t('search.removeTagFilter', { name })}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        <SearchablePopover<BlockRow>
          open={pagePopover.open}
          onOpenChange={pagePopover.setOpen}
          items={pagePopover.suggestions}
          isLoading={pagePopover.loading}
          onSelect={handleSelectPage}
          renderItem={(page) => page.content ?? 'Untitled'}
          keyExtractor={(page) => page.id}
          searchValue={pagePopover.query}
          onSearchChange={pagePopover.setQuery}
          searchPlaceholder={t('search.searchPages')}
          emptyMessage={t('search.noPagesFound')}
          triggerLabel={t('search.addPage')}
          triggerDisabled={filterPageId !== null}
          triggerDisabledReason={t('search.addPageDisabledReason')}
        />

        <SearchablePopover<TagCacheRow>
          open={tagPopover.open}
          onOpenChange={tagPopover.setOpen}
          items={tagPopover.suggestions}
          isLoading={tagPopover.loading}
          onSelect={handleSelectTag}
          renderItem={(tag) => `#${tag.name}`}
          keyExtractor={(tag) => tag.tag_id}
          searchValue={tagPopover.query}
          onSearchChange={tagPopover.setQuery}
          searchPlaceholder={t('search.searchTags')}
          emptyMessage={t('search.noTagsFound')}
          triggerLabel={t('search.addTag')}
          isItemDisabled={(tag) => filterTagIds.includes(tag.tag_id)}
        />

        {hasFilters && (
          <button
            type="button"
            onClick={() => dispatchFilter({ type: 'clear-all' })}
            className="text-xs text-muted-foreground hover:text-foreground underline ml-1 rounded-sm focus-ring-visible"
          >
            {t('search.clearAll')}
          </button>
        )}
      </div>

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

      {/* UX-269 — Status region: announces results-count changes to SR
          users and renders the visible count. Sits ABOVE the listbox as
          a separate sibling (NOT wrapping it) so interactive options
          aren't re-announced on every result-set change.

          UX-335 — also announce zero-result and search-cleared states so
          the live region is never silent after a state change that
          matters to SR users. Pre-search and loading states stay silent
          intentionally (no relevant change to announce). */}
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="search-results-status">
        {(() => {
          const statusText = getSearchStatusText(
            { searched, searchLoading, error, cleared, resultCount: results.length },
            t,
          )
          if (!statusText) return null
          return (
            <span className="text-xs text-muted-foreground" data-testid="search-results-count">
              {statusText}
            </span>
          )
        })()}
      </div>

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

      {results.length > 0 && (
        <div
          className="search-results space-y-3 list-none m-0 p-0"
          data-testid="search-results"
          role="listbox"
          tabIndex={0}
          aria-label={t('search.resultsListLabel')}
          onKeyDown={(e) => {
            if (handleListKeyDown(e)) e.preventDefault()
          }}
          aria-activedescendant={
            results[focusedIndex] ? `search-result-${results[focusedIndex].id}` : undefined
          }
        >
          {results.map((block, index) => (
            <div
              key={block.id}
              id={`search-result-${block.id}`}
              role="option"
              aria-selected={index === focusedIndex}
              tabIndex={-1}
              className={cn(index === focusedIndex && 'bg-accent rounded-lg')}
            >
              <ResultCard
                block={block}
                onClick={() => handleResultClick(block)}
                disabled={loadingResultId === block.id}
                showSpinner={loadingResultId === block.id}
                contentClassName="line-clamp-2"
              >
                {block.page_id && pageTitles.get(block.page_id) && (
                  <p className="text-xs text-muted-foreground mt-1">
                    in:{' '}
                    <PageLink pageId={block.page_id} title={pageTitles.get(block.page_id) ?? ''} />
                  </p>
                )}
              </ResultCard>
            </div>
          ))}
        </div>
      )}

      <LoadMoreButton
        hasMore={hasMore}
        loading={searchLoading}
        onLoadMore={loadMore}
        className="search-load-more"
      />
    </div>
  )
}
