/**
 * LinkedReferences -- shows backlinks to the current page, grouped by source page.
 *
 * Renders at the bottom of PageEditor. Groups backlinks by the page they originate
 * from, with collapsible headers for both the section and individual groups.
 * Uses cursor-based pagination with "Load more" button.
 */

import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort, BlockRow } from '../lib/tauri'
import {
  batchResolve,
  listBacklinksGrouped,
  listPropertyKeys,
  listTagsByPrefix,
} from '../lib/tauri'
import { BacklinkFilterBuilder } from './BacklinkFilterBuilder'
import { SourcePageFilter } from './SourcePageFilter'
import { renderRichContent } from './StaticBlock'

export interface LinkedReferencesProps {
  pageId: string
  onNavigateToPage?: (pageId: string, title: string, blockId?: string) => void
}

export function LinkedReferences({
  pageId,
  onNavigateToPage,
}: LinkedReferencesProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<BacklinkGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [sourcePageIncluded, setSourcePageIncluded] = useState<string[]>([])
  const [sourcePageExcluded, setSourcePageExcluded] = useState<string[]>([])
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  // Resolve cache for [[ULID]] and #[ULID] tokens
  const [resolveVersion, setResolveVersion] = useState(0)
  const resolveCache = useRef<Map<string, { title: string; deleted: boolean; cachedAt: number }>>(
    new Map(),
  )

  // Fetch grouped backlinks
  const fetchGroups = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        // Build combined filters: advanced filters + source page filter
        const allFilters = [...filters]
        if (sourcePageIncluded.length > 0 || sourcePageExcluded.length > 0) {
          allFilters.push({
            type: 'SourcePage',
            included: sourcePageIncluded,
            excluded: sourcePageExcluded,
          })
        }

        const resp = await listBacklinksGrouped({
          pageId,
          filters: allFilters.length > 0 ? allFilters : undefined,
          sort: sort ?? undefined,
          limit: 50,
          cursor,
        })
        if (cursor) {
          // Append: merge groups with same page_id
          setGroups((prev) => {
            const merged = [...prev]
            for (const newGroup of resp.groups) {
              const existing = merged.find((g) => g.page_id === newGroup.page_id)
              if (existing) {
                existing.blocks = [...existing.blocks, ...newGroup.blocks]
              } else {
                merged.push(newGroup)
              }
            }
            return merged
          })
          // Expand newly added groups by default
          setGroupExpanded((prev) => {
            const next = { ...prev }
            for (const newGroup of resp.groups) {
              if (!(newGroup.page_id in next)) {
                next[newGroup.page_id] = true
              }
            }
            return next
          })
        } else {
          setGroups(resp.groups)
          // Set default expand state
          const expandState: Record<string, boolean> = {}
          for (let i = 0; i < resp.groups.length; i++) {
            expandState[resp.groups[i].page_id] = resp.groups.length <= 5 || i < 3
          }
          setGroupExpanded(expandState)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.total_count)
      } catch {
        toast.error(t('references.loadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [pageId, filters, sort, sourcePageIncluded, sourcePageExcluded, t],
  )

  // Load property keys on mount
  useEffect(() => {
    listPropertyKeys()
      .then(setPropertyKeys)
      .catch((e) => {
        console.error(e)
        toast.error(t('references.loadPropertiesFailed'))
      })
  }, [t])

  // Load tags on mount
  useEffect(() => {
    listTagsByPrefix({ prefix: '' })
      .then((result) => setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name }))))
      .catch((e) => {
        console.error(e)
        toast.error(t('references.loadTagsFailed'))
      })
  }, [t])

  // Fetch on mount and when pageId/filters change
  useEffect(() => {
    setGroups([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    resolveCache.current.clear()
    fetchGroups()
  }, [fetchGroups])

  // Reset filter state when navigating to a different page
  // Uses functional updaters to avoid no-op state updates on initial mount
  // (which would re-create fetchGroups and trigger a duplicate fetch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageId is the intentional trigger for resetting filter state on navigation
  useEffect(() => {
    setFilters((prev) => (prev.length > 0 ? [] : prev))
    setSort((prev) => (prev !== null ? null : prev))
    setSourcePageIncluded((prev) => (prev.length > 0 ? [] : prev))
    setSourcePageExcluded((prev) => (prev.length > 0 ? [] : prev))
    setShowAdvancedFilters(false)
  }, [pageId])

  // Resolve [[ULID]] and #[ULID] tokens in block content
  useEffect(() => {
    const allBlocks = groups.flatMap((g) => g.blocks)
    if (allBlocks.length === 0) return

    const ULID_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const TAG_RE = /#\[([0-9A-Z]{26})\]/g
    const idsToResolve = new Set<string>()

    for (const block of allBlocks) {
      if (!block.content) continue
      for (const m of block.content.matchAll(ULID_RE)) idsToResolve.add(m[1])
      for (const m of block.content.matchAll(TAG_RE)) idsToResolve.add(m[1])
    }

    // Remove already-cached IDs (skip expired entries so they get re-fetched)
    const TTL_MS = 5 * 60 * 1000
    for (const id of idsToResolve) {
      const cached = resolveCache.current.get(id)
      if (cached && Date.now() - cached.cachedAt <= TTL_MS) {
        idsToResolve.delete(id)
      }
    }

    if (idsToResolve.size === 0) {
      setResolveVersion((v) => v + 1)
      return
    }

    let cancelled = false

    batchResolve([...idsToResolve])
      .then((resolved) => {
        if (cancelled) return
        const now = Date.now()
        for (const [key, entry] of resolveCache.current) {
          if (now - entry.cachedAt > TTL_MS) {
            resolveCache.current.delete(key)
          }
        }
        const MAX_CACHE_SIZE = 1000
        if (resolveCache.current.size + idsToResolve.size > MAX_CACHE_SIZE) {
          const overflow = resolveCache.current.size + idsToResolve.size - MAX_CACHE_SIZE
          const keys = resolveCache.current.keys()
          for (let i = 0; i < overflow; i++) {
            const next = keys.next()
            if (next.done) break
            resolveCache.current.delete(next.value)
          }
        }
        for (const r of resolved) {
          resolveCache.current.set(r.id, {
            title:
              r.title?.slice(0, 60) ||
              (r.block_type === 'tag' ? `#${r.id.slice(0, 8)}...` : `[[${r.id.slice(0, 8)}...]]`),
            deleted: r.deleted,
            cachedAt: Date.now(),
          })
        }
        for (const id of idsToResolve) {
          if (!resolveCache.current.has(id)) {
            resolveCache.current.set(id, {
              title: `[[${id.slice(0, 8)}...]]`,
              deleted: true,
              cachedAt: Date.now(),
            })
          }
        }
        setResolveVersion((v) => v + 1)
      })
      .catch(() => {
        if (!cancelled) setResolveVersion((v) => v + 1)
      })

    return () => {
      cancelled = true
    }
  }, [groups])

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockTitle = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `[[${id.slice(0, 8)}...]]`
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveBlockStatus = useCallback(
    (id: string): 'active' | 'deleted' => {
      return resolveCache.current.get(id)?.deleted ? 'deleted' : 'active'
    },
    [resolveVersion],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveVersion forces re-creation so render picks up cache updates
  const resolveTagName = useCallback(
    (id: string): string => {
      return resolveCache.current.get(id)?.title ?? `#${id.slice(0, 8)}...`
    },
    [resolveVersion],
  )

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  const toggleGroup = useCallback((groupPageId: string) => {
    setGroupExpanded((prev) => ({
      ...prev,
      [groupPageId]: !prev[groupPageId],
    }))
  }, [])

  const handleBlockClick = useCallback(
    (block: BlockRow, groupPageId: string, groupPageTitle: string | null) => {
      onNavigateToPage?.(groupPageId, groupPageTitle ?? 'Untitled', block.id)
    },
    [onNavigateToPage],
  )

  const handleBlockKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      block: BlockRow,
      groupPageId: string,
      groupPageTitle: string | null,
    ) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleBlockClick(block, groupPageId, groupPageTitle)
      }
    },
    [handleBlockClick],
  )

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchGroups(nextCursor)
    }
  }, [nextCursor, fetchGroups])

  // Empty state: hidden entirely
  if (!loading && totalCount === 0 && groups.length === 0) {
    return null
  }

  // Derive sourcePages from groups for SourcePageFilter
  const sourcePages = groups.map((g) => ({
    pageId: g.page_id,
    pageTitle: g.page_title,
    blockCount: g.blocks.length,
  }))

  const headerLabel =
    totalCount === 1 ? t('references.headerOne') : t('references.header', { count: totalCount })

  return (
    <section className="linked-references" aria-label="References">
      {/* Main header -- collapsible */}
      <button
        type="button"
        onClick={toggleExpanded}
        className="linked-references-header flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        {headerLabel}
      </button>

      {expanded && (
        <div className="linked-references-content mt-1 space-y-2">
          {/* Loading skeletons */}
          {loading && groups.length === 0 && (
            <div className="linked-references-loading space-y-2" aria-busy="true" role="status">
              <Skeleton className="h-8 w-48 rounded-md" />
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          )}

          {/* Filter controls */}
          <div className="linked-references-filters flex items-center gap-2 px-2">
            <SourcePageFilter
              sourcePages={sourcePages}
              included={sourcePageIncluded}
              excluded={sourcePageExcluded}
              onChange={(inc, exc) => {
                setSourcePageIncluded(inc)
                setSourcePageExcluded(exc)
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setShowAdvancedFilters((prev) => !prev)}
              aria-expanded={showAdvancedFilters}
            >
              {showAdvancedFilters ? t('references.hideFilters') : t('references.moreFilters')}
            </Button>
          </div>

          {showAdvancedFilters && (
            <div className="linked-references-advanced-filters px-2">
              <BacklinkFilterBuilder
                filters={filters}
                sort={sort}
                onFiltersChange={setFilters}
                onSortChange={setSort}
                totalCount={totalCount}
                filteredCount={totalCount}
                propertyKeys={propertyKeys}
                tags={tags}
                tagResolver={resolveTagName}
              />
            </div>
          )}

          {groups.map((group) => (
            <div key={group.page_id} className="linked-references-group">
              {/* Group header -- collapsible */}
              <button
                type="button"
                onClick={() => toggleGroup(group.page_id)}
                className="linked-references-group-header flex w-full items-center gap-2 rounded-md px-3 py-1 text-sm font-medium hover:bg-accent/50 transition-colors"
                aria-expanded={groupExpanded[group.page_id] ?? false}
              >
                {groupExpanded[group.page_id] ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                {group.page_title ?? t('references.untitled')} ({group.blocks.length})
              </button>

              {groupExpanded[group.page_id] && (
                <ul
                  className="linked-references-blocks ml-4 mt-1 space-y-1"
                  aria-label={t('references.backlinksFrom', {
                    title: group.page_title ?? t('references.untitled'),
                  })}
                >
                  {group.blocks.map((block) => (
                    <li
                      key={block.id}
                      className="linked-reference-item flex items-center gap-3 border-b py-2 px-1 last:border-b-0 cursor-pointer hover:bg-muted/50"
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                      tabIndex={0}
                      onClick={() => handleBlockClick(block, group.page_id, group.page_title)}
                      onKeyDown={(e) =>
                        handleBlockKeyDown(e, block, group.page_id, group.page_title)
                      }
                    >
                      <Badge variant="secondary" className="linked-reference-item-type shrink-0">
                        {block.block_type}
                      </Badge>
                      <span className="linked-reference-item-text text-sm flex-1 truncate">
                        {block.content
                          ? renderRichContent(block.content, {
                              resolveBlockTitle,
                              resolveTagName,
                              resolveBlockStatus,
                            })
                          : t('references.empty')}
                      </span>
                      <span className="linked-reference-item-id text-xs text-muted-foreground font-mono">
                        {block.id.slice(0, 8)}...
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="linked-references-load-more w-full"
              onClick={loadMore}
              disabled={loading}
              aria-busy={loading}
              aria-label={loading ? t('references.loadingMore') : t('references.loadMoreLabel')}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t('references.loading')}
                </>
              ) : (
                t('references.loadMore')
              )}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
