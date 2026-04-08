/**
 * TagFilterPanel — boolean tag filter with AND/OR/NOT mode (p3-t9).
 *
 * Lets users select multiple tags via prefix search and see blocks
 * matching all (AND), any (OR), or none (NOT) of the selected tags.
 * Results are paginated with cursor-based "Load more" via usePaginatedQuery.
 */

import { Plus, Search, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import type { BlockRow } from '../lib/tauri'
import { getBlock, listTagsByPrefix, queryByTags } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
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
  const navigateToPage = useNavigationStore((s) => s.navigateToPage)

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
            <Badge
              key={tag.id}
              variant="secondary"
              className="gap-1 truncate max-w-[150px]"
              title={tag.name}
            >
              <span className="truncate">{tag.name}</span>
              <button
                type="button"
                className="ml-1 rounded-full hover:bg-muted"
                onClick={() => handleRemoveTag(tag.id)}
                aria-label={t('tagFilter.removeTagLabel', { name: tag.name })}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
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
          <div className="space-y-1">
            {filteredMatching.map((tag) => (
              <div
                key={tag.tag_id}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/50 active:bg-accent/70"
              >
                <span>
                  <HighlightPrefix text={tag.name} prefix={prefix} /> ({tag.usage_count})
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1 px-2"
                  onClick={() => handleAddTag(tag)}
                >
                  <Plus className="h-3 w-3" />
                  {t('tagFilter.addButton')}
                </Button>
              </div>
            ))}
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
          {results.map((block) => (
            <ResultCard
              key={block.id}
              block={block}
              onClick={() => handleResultClick(block)}
              contentClassName="whitespace-pre-wrap"
            />
          ))}
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
