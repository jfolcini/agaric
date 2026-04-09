/**
 * SearchPanel — full-text search across all blocks (p3-t5, p3-t6).
 *
 * Features:
 *  - Debounced search (300ms) on input change
 *  - Immediate search on form submit (Enter / button click)
 *  - Cursor-based pagination ("Load more") via usePaginatedQuery
 *  - CJK limitation notice (p3-t6)
 */

import { Search, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardButton } from '@/components/ui/card-button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { addRecentPage, getRecentPages, type RecentPage } from '../lib/recent-pages'
import type { BlockRow, TagCacheRow } from '../lib/tauri'
import { batchResolve, getBlock, listBlocks, listTagsByPrefix, searchBlocks } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { EmptyState } from './EmptyState'
import { PageLink } from './PageLink'
import { ResultCard } from './ResultCard'
import { SearchablePopover } from './SearchablePopover'

/** Returns true if the text contains CJK codepoints. */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F\uAC00-\uD7AF]/.test(
    text,
  )
}

export function SearchPanel(): React.ReactElement {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searched, setSearched] = useState(false)
  const [typing, setTyping] = useState(false)
  const [loadingResultId, setLoadingResultId] = useState<string | null>(null)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [recentPages, setRecentPages] = useState<RecentPage[]>([])
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

  // Filter state
  const [filterPageId, setFilterPageId] = useState<string | null>(null)
  const [filterPageTitle, setFilterPageTitle] = useState<string | null>(null)
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])
  const [filterTagNames, setFilterTagNames] = useState<string[]>([])

  // Page picker state
  const [pagePopoverOpen, setPagePopoverOpen] = useState(false)
  const [pageSearch, setPageSearch] = useState('')
  const [pageSuggestions, setPageSuggestions] = useState<BlockRow[]>([])
  const [pageSearchLoading, setPageSearchLoading] = useState(false)

  // Tag picker state
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false)
  const [tagSearch, setTagSearch] = useState('')
  const [tagSuggestions, setTagSuggestions] = useState<TagCacheRow[]>([])
  const [tagSearchLoading, setTagSearchLoading] = useState(false)

  const hasFilters = filterPageId !== null || filterTagIds.length > 0

  // Load recent pages from localStorage on mount
  useEffect(() => {
    setRecentPages(getRecentPages())
  }, [])

  const queryFn = useCallback(
    (cursor?: string) =>
      searchBlocks({
        query: debouncedQuery,
        parentId: filterPageId ?? undefined,
        tagIds: filterTagIds.length > 0 ? filterTagIds : undefined,
        cursor,
        limit: 50,
      }),
    [debouncedQuery, filterPageId, filterTagIds],
  )

  const {
    items: results,
    loading: searchLoading,
    hasMore,
    loadMore,
    error,
    setItems,
  } = usePaginatedQuery(queryFn, {
    enabled: debouncedQuery.length > 0,
    onError: t('search.failed'),
  })

  // Resolve page titles for breadcrumbs when results change
  useEffect(() => {
    const parentIds = results.map((b) => b.parent_id).filter((id): id is string => id != null)
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
      .catch(() => {
        // breadcrumbs are non-critical
      })
  }, [results])

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
      setDebouncedQuery('')
      setItems([])
      setSearched(false)
      setTyping(false)
      return
    }

    setTyping(true)
    debounced.schedule(value)
  }

  // Auto-focus search input on mount
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search blocks"]')
    input?.focus()
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
          } catch {
            toast.error(t('search.loadResultsFailed'))
          }
        } else {
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

  // Page picker: search pages on input change
  useEffect(() => {
    if (!pagePopoverOpen) return
    setPageSearchLoading(true)
    listBlocks({ blockType: 'page', limit: 20 })
      .then((res) => {
        const filtered = pageSearch
          ? res.items.filter((b) =>
              (b.content ?? '').toLowerCase().includes(pageSearch.toLowerCase()),
            )
          : res.items
        setPageSuggestions(filtered)
      })
      .catch(() => setPageSuggestions([]))
      .finally(() => setPageSearchLoading(false))
  }, [pagePopoverOpen, pageSearch])

  // Tag picker: search tags on input change
  useEffect(() => {
    if (!tagPopoverOpen) return
    setTagSearchLoading(true)
    listTagsByPrefix({ prefix: tagSearch, limit: 20 })
      .then((tags) => setTagSuggestions(tags))
      .catch(() => setTagSuggestions([]))
      .finally(() => setTagSearchLoading(false))
  }, [tagPopoverOpen, tagSearch])

  function handleSelectPage(page: BlockRow) {
    setFilterPageId(page.id)
    setFilterPageTitle(page.content ?? 'Untitled')
    setPagePopoverOpen(false)
    setPageSearch('')
  }

  function handleRemovePageFilter() {
    setFilterPageId(null)
    setFilterPageTitle(null)
  }

  function handleSelectTag(tag: TagCacheRow) {
    if (filterTagIds.includes(tag.tag_id)) return
    setFilterTagIds((prev) => [...prev, tag.tag_id])
    setFilterTagNames((prev) => [...prev, tag.name])
    setTagPopoverOpen(false)
    setTagSearch('')
  }

  function handleRemoveTag(index: number) {
    setFilterTagIds((prev) => prev.filter((_, i) => i !== index))
    setFilterTagNames((prev) => prev.filter((_, i) => i !== index))
  }

  function handleClearAllFilters() {
    setFilterPageId(null)
    setFilterPageTitle(null)
    setFilterTagIds([])
    setFilterTagNames([])
  }

  return (
    <div className="search-panel space-y-4">
      {/* biome-ignore lint/a11y/useSemanticElements: jsdom doesn't support <search> element */}
      <form
        onSubmit={handleSubmit}
        role="search"
        className="sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Input
          value={query}
          onChange={handleInputChange}
          placeholder={t('search.searchPlaceholder')}
          aria-label={t('search.searchLabel')}
          className="flex-1"
          autoFocus
        />
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          Search
        </Button>
        {(typing || searchLoading) && <Spinner className="text-muted-foreground" />}
      </form>

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
              onClick={handleRemovePageFilter}
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
              onClick={() => handleRemoveTag(index)}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              aria-label={t('search.removeTagFilter', { name })}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        <SearchablePopover<BlockRow>
          open={pagePopoverOpen}
          onOpenChange={setPagePopoverOpen}
          items={pageSuggestions}
          isLoading={pageSearchLoading}
          onSelect={handleSelectPage}
          renderItem={(page) => page.content ?? 'Untitled'}
          keyExtractor={(page) => page.id}
          searchValue={pageSearch}
          onSearchChange={setPageSearch}
          searchPlaceholder={t('search.searchPages')}
          emptyMessage={t('search.noPagesFound')}
          triggerLabel={t('search.addPage')}
          triggerDisabled={filterPageId !== null}
        />

        <SearchablePopover<TagCacheRow>
          open={tagPopoverOpen}
          onOpenChange={setTagPopoverOpen}
          items={tagSuggestions}
          isLoading={tagSearchLoading}
          onSelect={handleSelectTag}
          renderItem={(tag) => `#${tag.name}`}
          keyExtractor={(tag) => tag.tag_id}
          searchValue={tagSearch}
          onSearchChange={setTagSearch}
          searchPlaceholder={t('search.searchTags')}
          emptyMessage={t('search.noTagsFound')}
          triggerLabel={t('search.addTag')}
          isItemDisabled={(tag) => filterTagIds.includes(tag.tag_id)}
        />

        {hasFilters && (
          <button
            type="button"
            onClick={handleClearAllFilters}
            className="text-xs text-muted-foreground hover:text-foreground underline ml-1"
          >
            {t('search.clearAll')}
          </button>
        )}
      </div>

      {hasCJK(query) && (
        <div className="rounded-lg border border-alert-info-border bg-alert-info p-3 text-sm text-alert-info-foreground">
          <span className="font-medium">{t('search.cjkNoteLabel')}</span>{' '}
          {t('search.cjkLimitationNote')}
        </div>
      )}

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

      <div aria-live="polite">
        {searched && !searchLoading && results.length === 0 && !error && (
          <EmptyState icon={Search} message={t('search.noResultsFound')} />
        )}

        {results.length > 0 && (
          <div
            className="search-results space-y-3 list-none m-0 p-0"
            data-testid="search-results"
            role="listbox"
            tabIndex={0}
            aria-label="Search results"
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
                  highlightText={debouncedQuery}
                >
                  {block.parent_id && pageTitles.get(block.parent_id) && (
                    <p className="text-xs text-muted-foreground mt-1">
                      in:{' '}
                      <PageLink
                        pageId={block.parent_id}
                        title={pageTitles.get(block.parent_id) ?? ''}
                      />
                    </p>
                  )}
                </ResultCard>
              </div>
            ))}
          </div>
        )}
        {searched && !searchLoading && !error && results.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('search.resultsCount', { count: results.length })}
          </span>
        )}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="search-load-more w-full"
          onClick={loadMore}
          disabled={searchLoading}
        >
          {searchLoading ? t('search.loadingMessage') : t('search.loadMoreButton')}
        </Button>
      )}
    </div>
  )
}
