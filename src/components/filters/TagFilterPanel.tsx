/**
 * TagFilterPanel — boolean tag filter with AND/OR/NOT mode (p3-t9).
 *
 * Lets users select multiple tags via prefix search and see blocks
 * matching all (AND), any (OR), or none (NOT) of the selected tags.
 * Results are paginated with cursor-based `t('tagFilter.loadMoreButton')` via usePaginatedQuery.
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ResultCard } from '@/components/common/ResultCard'
import { PageLink } from '@/components/pages/PageLink'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import { SearchInput } from '@/components/ui/search-input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { compileTagBuilder, tagBuilderHasLeaves } from '@/lib/tagExpr'
import type { BlockRow } from '@/lib/tauri'
import { batchResolve, getBlock, listTagsByPrefix, queryByTags } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

import { TagComposer, useTagComposerState } from './TagComposer'

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

/** The "N blocks match …" / "select tags" feedback line under the controls. */
function FilterFeedback({
  hasQuery,
  loading,
  resultCount,
  flat,
  selectedCount,
  mode,
}: {
  hasQuery: boolean
  loading: boolean
  resultCount: number
  /** Flat default (composer closed) — append the "(N tags, MODE)" detail. */
  flat: boolean
  selectedCount: number
  mode: 'and' | 'or' | 'not'
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (!hasQuery) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
        {t('tagFilter.selectTagsMessage')}
      </p>
    )
  }
  if (loading || resultCount === 0) return null
  const matchText =
    resultCount === 1
      ? t('tagFilter.blockMatchOne', { count: resultCount })
      : t('tagFilter.blockMatchMany', { count: resultCount })
  return (
    <p className="text-sm text-muted-foreground" data-testid="tag-filter-feedback">
      {matchText}
      {flat && selectedCount > 0 && (
        <>
          {' '}
          {selectedCount}{' '}
          {selectedCount === 1 ? t('tagFilter.tagSingular') : t('tagFilter.tagPlural')} (
          {mode.toUpperCase()})
        </>
      )}
    </p>
  )
}

/** #1426 — the removable tag-prefix search pills (renders nothing when empty). */
function PrefixPillBar({
  prefixes,
  onRemove,
}: {
  prefixes: string[]
  onRemove: (prefix: string) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (prefixes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tag-filter-prefix-pills">
      <span className="text-sm text-muted-foreground">{t('tagFilter.prefixesLabel')}</span>
      {prefixes.map((p) => (
        <FilterPill
          key={p}
          label={t('tagFilter.prefixPillLabel', { prefix: p })}
          onRemove={() => onRemove(p)}
          removeAriaLabel={t('tagFilter.removePrefixLabel', { prefix: p })}
          className="truncate max-w-[180px]"
          title={p}
        />
      ))}
    </div>
  )
}

export function TagFilterPanel(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [prefix, setPrefix] = useState('')
  const [matchingTags, setMatchingTags] = useState<MatchingTag[]>([])
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>([])
  const [mode, setMode] = useState<'and' | 'or' | 'not'>('and')
  // #1426 — tag-prefix search pills, surfaced into the query (the panel used to
  // hardcode `prefixes: []`). Each pill compiles to a `TagExpr::Prefix` leaf.
  const [prefixPills, setPrefixPills] = useState<string[]>([])
  // #1426 — opt-in single-level All/Any/None composer (mixes resolved-tag and
  // name-prefix leaves under one combinator). When `builder` is `null` the panel
  // runs the flat default (selected tags + prefix pills under `mode`), so
  // nothing regresses for users who never open the composer. When set, the
  // compiled builder params drive the query instead. The builder is constrained
  // to exactly what the flat `query_by_tags` IPC can execute — no deep nesting
  // or per-leaf negation, which the IPC cannot represent.
  const {
    builder: composer,
    callbacks: composerCallbacks,
    toggle: toggleComposer,
  } = useTagComposerState()
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
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
        notify.error(t('tags.loadFailed'), { id: 'tags-load-failed' })
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

  // #1426 — the active query params: the compiled composer params when the
  // composer is open and non-empty, otherwise the flat default (selected tags +
  // prefix pills under the single `mode`). `compileTagBuilder` lowers the
  // single-level builder LOSSLESSLY onto the flat `query_by_tags` IPC — the
  // builder only models what the IPC can faithfully run.
  const composerActive = composer != null && tagBuilderHasLeaves(composer)
  const queryParams = composerActive
    ? compileTagBuilder(composer)
    : { tagIds: selectedTags.map((tg) => tg.id), prefixes: prefixPills, mode }
  const hasQuery = queryParams.tagIds.length > 0 || queryParams.prefixes.length > 0

  // Block results via usePaginatedQuery
  const blockQueryFn = useCallback(
    (cursor?: string) =>
      queryByTags({
        tagIds: queryParams.tagIds,
        prefixes: queryParams.prefixes,
        mode: queryParams.mode,
        ...(cursor != null && { cursor }),
        limit: PAGINATION_LIMIT,
        spaceId: currentSpaceId,
      }),
    // Re-key on the serialized params so a composer/pill edit re-runs the query.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- queryParams is derived; the JSON key captures every input
    [JSON.stringify(queryParams), currentSpaceId],
  )

  const {
    items: results,
    loading,
    hasMore,
    loadMore,
    setItems,
  } = usePaginatedQuery(blockQueryFn, {
    enabled: hasQuery,
    onError: t('tags.loadFailed'),
  })

  // Clear items when the query goes empty (all tags + pills removed / composer empty)
  useEffect(() => {
    if (!hasQuery) setItems([])
  }, [hasQuery, setItems])

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

  // ── #1426 prefix pills ───────────────────────────────────────────
  const handleAddPrefixPill = useCallback(() => {
    const value = prefix.trim()
    if (!value) return
    setPrefixPills((prev) => (prev.includes(value) ? prev : [...prev, value]))
    setPrefix('')
    setMatchingTags([])
  }, [prefix])

  const handleRemovePrefixPill = useCallback((value: string) => {
    setPrefixPills((prev) => prev.filter((p) => p !== value))
  }, [])

  // Filter out already-selected tags from matching results
  const filteredMatching = matchingTags.filter((t) => !selectedTags.some((s) => s.id === t.tag_id))

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPrefix('')
        setMatchingTags([])
      }
      // #1426 — Enter promotes the typed text to a prefix pill.
      if (e.key === 'Enter' && prefix.trim()) {
        e.preventDefault()
        handleAddPrefixPill()
      }
      if (e.key === 'ArrowDown' && filteredMatching.length > 0 && matchingTagsRef.current) {
        e.preventDefault()
        matchingTagsRef.current.focus()
      }
    },
    [prefix, filteredMatching.length, handleAddPrefixPill],
  )

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
          notify.error(t('tags.loadFailed'))
        }
      }
    },
    [navigateToPage, t],
  )

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
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional — reset on results change
  useEffect(() => {
    setResultsFocusedIndex(0)
  }, [results.length, setResultsFocusedIndex])

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional — reset on matching tags change
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
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('tagFilter.title')}</h3>
        {/* #1426 — opt into the nested And/Or/Not composer. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleComposer}
          aria-pressed={composer != null}
          data-testid="tag-filter-composer-toggle"
        >
          {composer != null ? t('tagFilter.composer.hide') : t('tagFilter.composer.show')}
        </Button>
      </div>

      {/* Prefix search */}
      <div className="flex items-center gap-2">
        <SearchInput
          value={prefix}
          onChange={handlePrefixChange}
          onKeyDown={handleSearchKeyDown}
          placeholder={t('tagFilter.searchPlaceholder')}
          aria-label={t('tagFilter.searchLabel')}
          className="flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddPrefixPill}
          disabled={!prefix.trim()}
          aria-label={t('tagFilter.addPrefixLabel')}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('tagFilter.addPrefixButton')}
        </Button>
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {/* #1426 — prefix-search pills */}
      <PrefixPillBar prefixes={prefixPills} onRemove={handleRemovePrefixPill} />

      {/* #1426 — single-level All/Any/None composer (opt-in). Replaces the flat
          selected-tags + mode controls while open. */}
      {composer != null && <TagComposer builder={composer} {...composerCallbacks} />}

      {/* Selected tags */}
      {composer == null && selectedTags.length > 0 && (
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

      {/* AND/OR/NOT mode toggle (flat default; hidden while the composer is open) */}
      {composer == null && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('tagFilter.modeLabel')}</span>
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
        </div>
      )}

      {/* Filter feedback summary */}
      <FilterFeedback
        hasQuery={hasQuery}
        loading={loading}
        resultCount={results.length}
        flat={composer == null}
        selectedCount={selectedTags.length}
        mode={mode}
      />

      {/* Matching tags from prefix search */}
      {filteredMatching.length > 0 && (
        <section className="rounded-lg border bg-card p-3">
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">
            {t('tagFilter.matchingTagsTitle')}
          </h4>
          <div
            className="space-y-1"
            ref={matchingTagsRef}
            role="grid"
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
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- row inside an aria grid widget; a <tr> requires table ancestry and would break the flex layout
                  role="row"
                  aria-selected={isFocused}
                  data-matching-tag
                  tabIndex={-1}
                  className={cn(
                    'flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/50 active:bg-accent/70',
                    isFocused && 'ring-2 ring-inset ring-ring/50 bg-accent/30',
                  )}
                >
                  {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- text-only gridcell, focus stays on the row */}
                  {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell inside aria grid widget; <td> requires table ancestry and breaks the flex layout */}
                  <span role="gridcell">
                    <HighlightPrefix text={tag.name} prefix={prefix} /> ({tag.usage_count})
                  </span>
                  {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- gridcell focus is delegated to inner Button */}
                  {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell inside aria grid widget; <td> requires table ancestry and breaks the flex layout */}
                  <span role="gridcell">
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
                  </span>
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
      {hasQuery && !loading && results.length === 0 && (
        <div className="tag-filter-empty rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('tagFilter.noMatchesFound')}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <section className="tag-filter-results relative space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">
            {t('tagFilter.resultsTitle')} ({results.length})
          </h4>
          <div
            ref={resultsListRef}
            role="grid"
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
            aria-busy={loading}
            className={cn(
              'space-y-3 transition-opacity',
              loading && 'opacity-50 pointer-events-none',
            )}
          >
            {results.map((block, index) => {
              const isFocused = index === resultsFocusedIndex
              return (
                <div
                  key={block.id}
                  id={`tag-result-${block.id}`}
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- row inside an aria grid widget; a <tr> requires table ancestry and would break the layout
                  role="row"
                  aria-selected={isFocused}
                  data-result-item
                  tabIndex={-1}
                  className={cn(isFocused && 'ring-2 ring-inset ring-ring/50 rounded-lg')}
                >
                  {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- gridcell focus is delegated to inner ResultCard */}
                  {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell in aria grid widget; <td> requires table ancestry and breaks the layout */}
                  <div role="gridcell">
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
                </div>
              )
            })}
          </div>
          {loading && (
            <div
              className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- absolutely-positioned flex overlay; swapping to <output> would break the centering layout
              role="status"
              aria-live="polite"
              data-testid="tag-filter-results-loading"
            >
              <Spinner size="lg" />
              <span className="sr-only">{t('tagFilter.loadingMessage')}</span>
            </div>
          )}
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
