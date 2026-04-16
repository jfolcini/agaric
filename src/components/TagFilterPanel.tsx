/**
 * TagFilterPanel — boolean tag filter with AND/OR/NOT mode (p3-t9).
 *
 * Lets users select multiple tags via prefix search and see blocks
 * matching all (AND), any (OR), or none (NOT) of the selected tags.
 * Results are paginated with cursor-based "Load more" via usePaginatedQuery.
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, getBlock, listTagsByPrefix, queryByTags } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { PageLink } from './PageLink'
import { ResultCard } from './ResultCard'

interface SelectedTag {
  id: string
  name: string
}

interface MatchingTag {
  tag_id: string
  name: string
  usage_count: number
}

function HighlightPrefix({ text, prefix }: { text: string; prefix: string }): React.ReactElement {
  const trimmed = prefix.trim().toLowerCase()
  if (!trimmed || !text.toLowerCase().startsWith(trimmed)) {
    return <>{text}</>
  }
  return (
    <>
      <strong>{text.slice(0, trimmed.length)}</strong>
      {text.slice(trimmed.length)}
    </>
  )
}

export function TagFilterPanel(): React.ReactElement {
  const { t } = useTranslation()
  const [prefix, setPrefix] = useState('')
  const [matchingTags, setMatchingTags] = useState<MatchingTag[]>([])
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>([])
  const [mode, setMode] = useState<'and' | 'or' | 'not'>('and')
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)
  const resultsListRef = useRef<HTMLDivElement>(null)
  const matchingTagsRef = useRef<HTMLDivElement>(null)

  // Debounced prefix search
  const searchTags = useCallback(
    async (p: string) => {
      try {
        const tags = await listTagsByPrefix({ prefix: p })
        setMatchingTags(
          tags.map((t) => ({
            tag_id: t.tag_id,
            name: t.name,
            usage_count: t.usage_count,
          })),
        )
      } catch {
        toast.error(t('tags.loadFailed'))
      }
    },
    [t],
  )

  const debounced = useDebouncedCallback((value) => {
    searchTags(value)
  }, 300)

  function handlePrefixChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setPrefix(value)

    debounced.cancel()

    if (!value.trim()) {
      setMatchingTags([])
      return
    }

    debounced.schedule(value)
  }

  // Block results via usePaginatedQuery
  const blockQueryFn = useCallback(
    (cursor?: string) =>
      queryByTags({
        tagIds: selectedTags.map((t) => t.id),
        prefixes: [],
        mode,
        ...(cursor != null && { cursor }),
        limit: 50,
      }),
    [selectedTags, mode],
  )

  const {
    items: results,
    loading,
    hasMore,
    loadMore,
    setItems,
  } = usePaginatedQuery(blockQueryFn, {
    enabled: selectedTags.length > 0,
    onError: t('tags.loadFailed'),
  })

  // Clear items when all tags are removed
  useEffect(() => {
    if (selectedTags.length === 0) setItems([])
  }, [selectedTags.length, setItems])

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
        logger.warn('TagFilterPanel', 'breadcrumb resolution failed', undefined, err)
      })
  }, [results])

  const handleAddTag = useCallback(
    (tag: MatchingTag) => {
      if (selectedTags.some((t) => t.id === tag.tag_id)) return
      setSelectedTags((prev) => [...prev, { id: tag.tag_id, name: tag.name }])
    },
    [selectedTags],
  )

  const handleRemoveTag = useCallback((tagId: string) => {
    setSelectedTags((prev) => prev.filter((t) => t.id !== tagId))
  }, [])

  const handleResultClick = useCallback(
    async (block: BlockRow) => {
      if (block.block_type === 'page') {
        navigateToPage(block.id, block.content ?? 'Untitled')
        return
      }
      if (block.parent_id) {
        try {
          const parent = await getBlock(block.parent_id)
          navigateToPage(block.parent_id, parent.content ?? 'Untitled', block.id)
        } catch {
          toast.error(t('tags.loadFailed'))
        }
      }
    },
    [navigateToPage, t],
  )

  // Filter out already-selected tags from matching results
  const filteredMatching = matchingTags.filter((t) => !selectedTags.some((s) => s.id === t.tag_id))

  // ── List keyboard navigation ─────────────────────────────────────
  const {
    focusedIndex: resultsFocusedIndex,
    setFocusedIndex: setResultsFocusedIndex,
    handleKeyDown: resultsHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: results.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (index: number) => {
      const block = results[index]
      if (block) handleResultClick(block)
    },
  })

  const {
    focusedIndex: matchingFocusedIndex,
    setFocusedIndex: setMatchingFocusedIndex,
    handleKeyDown: matchingHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredMatching.length,
    homeEnd: true,
    onSelect: (index: number) => {
      const tag = filteredMatching[index]
      if (tag) handleAddTag(tag)
    },
  })

  // Reset focused index when items change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on results change
  useEffect(() => {
    setResultsFocusedIndex(0)
  }, [results.length, setResultsFocusedIndex])

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on matching tags change
  useEffect(() => {
    setMatchingFocusedIndex(0)
  }, [filteredMatching.length, setMatchingFocusedIndex])

  // Scroll focused result into view
  useEffect(() => {
    if (resultsFocusedIndex < 0 || !resultsListRef.current) return
    const items = resultsListRef.current.querySelectorAll('[data-result-item]')
    const el = items[resultsFocusedIndex] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [resultsFocusedIndex])

  // Scroll focused matching tag into view
  useEffect(() => {
    if (matchingFocusedIndex < 0 || !matchingTagsRef.current) return
    const items = matchingTagsRef.current.querySelectorAll('[data-matching-tag]')
    const el = items[matchingFocusedIndex] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [matchingFocusedIndex])

  return (
    <div className="tag-filter-panel space-y-4">
      <h3 className="text-sm font-semibold">{t('tagFilter.title')}</h3>

      {/* Prefix search */}
      <div className="flex items-center gap-2">
        <Input
          value={prefix}
          onChange={handlePrefixChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setPrefix('')
              setMatchingTags([])
            }
            if (e.key === 'ArrowDown' && filteredMatching.length > 0 && matchingTagsRef.current) {
              e.preventDefault()
              matchingTagsRef.current.focus()
            }
          }}
          placeholder={t('tagFilter.searchPlaceholder')}
          aria-label={t('tagFilter.searchLabel')}
          className="flex-1"
        />
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {/* Selected tags */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('tagFilter.selectedLabel')}</span>
          {selectedTags.map((tag) => (
            <FilterPill
              key={tag.id}
              label={tag.name}
              onRemove={() => handleRemoveTag(tag.id)}
              removeAriaLabel={t('tagFilter.removeTagLabel', { name: tag.name })}
              className="truncate max-w-[150px]"
              title={tag.name}
            />
          ))}
        </div>
      )}

      {/* AND/OR/NOT mode toggle */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('tagFilter.modeLabel')}</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === 'and' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('and')}
                aria-pressed={mode === 'and'}
              >
                {t('tagFilter.andMode')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('tagFilter.andModeTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === 'or' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('or')}
                aria-pressed={mode === 'or'}
              >
                {t('tagFilter.orMode')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('tagFilter.orModeTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={mode === 'not' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('not')}
                aria-pressed={mode === 'not'}
              >
                {t('tagFilter.notMode')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('tagFilter.notModeTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Filter feedback summary */}
      {selectedTags.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
          {t('tagFilter.selectTagsMessage')}
        </p>
      )}
      {selectedTags.length > 0 && !loading && results.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
          {results.length === 1
            ? t('tagFilter.blockMatchOne', { count: results.length })
            : t('tagFilter.blockMatchMany', { count: results.length })}{' '}
          {selectedTags.length}{' '}
          {selectedTags.length === 1 ? t('tagFilter.tagSingular') : t('tagFilter.tagPlural')} (
          {mode.toUpperCase()})
        </p>
      )}

      {/* Matching tags from prefix search */}
      {filteredMatching.length > 0 && (
        <section className="rounded-lg border bg-card p-3">
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">
            {t('tagFilter.matchingTagsTitle')}
          </h4>
          <div
            className="space-y-1"
            ref={matchingTagsRef}
            role="listbox"
            aria-label={t('tagFilter.matchingTagsTitle')}
            tabIndex={0}
            onKeyDown={(e) => {
              if (matchingHandleKeyDown(e)) {
                e.preventDefault()
              }
            }}
          >
            {filteredMatching.map((tag, index) => {
              const isFocused = index === matchingFocusedIndex
              return (
                <div
                  key={tag.tag_id}
                  role="option"
                  aria-selected={isFocused}
                  data-matching-tag
                  tabIndex={-1}
                  className={cn(
                    'flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/50 active:bg-accent/70',
                    isFocused && 'ring-2 ring-ring/50 bg-accent/30',
                  )}
                >
                  <span>
                    <HighlightPrefix text={tag.name} prefix={prefix} /> ({tag.usage_count})
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 px-2"
                    onClick={() => handleAddTag(tag)}
                    tabIndex={-1}
                  >
                    <Plus className="h-3 w-3" />
                    {t('tagFilter.addButton')}
                  </Button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Loading indicator */}
      {loading && results.length === 0 && (
        <LoadingSkeleton count={3} height="h-12" className="tag-filter-loading" />
      )}

      {/* Empty results */}
      {selectedTags.length > 0 && !loading && results.length === 0 && (
        <div className="tag-filter-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('tagFilter.noMatchesFound')}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <section className="tag-filter-results space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">
            {t('tagFilter.resultsTitle')} ({results.length})
          </h4>
          <div
            ref={resultsListRef}
            role="listbox"
            tabIndex={0}
            onKeyDown={(e) => {
              if (resultsHandleKeyDown(e)) {
                e.preventDefault()
              }
            }}
            aria-activedescendant={
              resultsFocusedIndex >= 0 && results[resultsFocusedIndex]
                ? `tag-result-${results[resultsFocusedIndex].id}`
                : undefined
            }
            className="space-y-3"
          >
            {results.map((block, index) => {
              const isFocused = index === resultsFocusedIndex
              return (
                <div
                  key={block.id}
                  id={`tag-result-${block.id}`}
                  role="option"
                  aria-selected={isFocused}
                  data-result-item
                  tabIndex={-1}
                  className={cn(isFocused && 'ring-2 ring-ring/50 rounded-lg')}
                >
                  <ResultCard
                    block={block}
                    onClick={() => handleResultClick(block)}
                    contentClassName="whitespace-pre-wrap"
                  >
                    {block.page_id && pageTitles.get(block.page_id) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('tagFilter.inPage')}{' '}
                        <PageLink
                          pageId={block.page_id}
                          title={pageTitles.get(block.page_id) ?? ''}
                        />
                      </p>
                    )}
                  </ResultCard>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Load more */}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="tag-filter-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? t('tagFilter.loadingMessage') : t('tagFilter.loadMoreButton')}
        </Button>
      )}
    </div>
  )
}
