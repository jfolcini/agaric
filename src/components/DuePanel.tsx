/**
 * DuePanel -- shows blocks due on a given date, grouped by todo_state.
 *
 * Renders on JournalPage. Groups blocks by todo_state in order:
 * DOING > TODO > DONE > null (Other). Within each group, sorts by
 * priority: 1 > 2 > 3 > null. Uses cursor-based pagination with
 * "Load more" button.
 */

import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BlockRow, ProjectedAgendaEntry } from '../lib/tauri'
import { batchResolve, listBlocks, listProjectedAgenda } from '../lib/tauri'

export interface DuePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: (pageId: string, title: string, blockId?: string) => void
}

const GROUP_ORDER = ['DOING', 'TODO', 'DONE', null] as const

/** Priority sort key: '1' → 1, '2' → 2, '3' → 3, null → 4 */
function priorityKey(p: string | null): number {
  if (p === '1') return 1
  if (p === '2') return 2
  if (p === '3') return 3
  return 4
}

/** Badge color class by priority level. */
function priorityColor(p: string): string {
  if (p === '1') return 'bg-red-500 text-white'
  if (p === '2') return 'bg-yellow-500 text-white'
  return 'bg-blue-500 text-white'
}

/** Truncate content to plain text. */
function truncateContent(content: string | null, max = 120): string {
  if (!content) return '(empty)'
  const plain = content.replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}

export function DuePanel({ date, onNavigateToPage }: DuePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [projectedEntries, setProjectedEntries] = useState<ProjectedAgendaEntry[]>([])
  const [projectedLoading, setProjectedLoading] = useState(false)

  // Fetch blocks due on the given date
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await listBlocks({
          agendaDate: date,
          agendaSource: sourceFilter ?? undefined,
          cursor,
          limit: 50,
        })
        const newBlocks = cursor ? [...blocks, ...resp.items] : resp.items
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + resp.items.length : resp.items.length)

        // Resolve parent page titles
        const allBlocks = cursor ? [...blocks, ...resp.items] : resp.items
        const uniqueParentIds = [
          ...new Set(allBlocks.map((b) => b.parent_id).filter((id): id is string => id != null)),
        ]
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          const titleMap = new Map(pageTitles)
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? 'Untitled')
          }
          setPageTitles(titleMap)
        }
      } catch {
        // Silently handle errors
      } finally {
        setLoading(false)
      }
    },
    [date, blocks, totalCount, pageTitles, sourceFilter],
  )

  // Fetch on mount and when date or sourceFilter changes
  useEffect(() => {
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setPageTitles(new Map())
    setCollapsed(false)

    let cancelled = false
    const doFetch = async () => {
      setLoading(true)
      try {
        const resp = await listBlocks({
          agendaDate: date,
          agendaSource: sourceFilter ?? undefined,
          limit: 50,
        })
        if (cancelled) return
        setBlocks(resp.items)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.items.length)

        // Resolve parent page titles
        const uniqueParentIds = [
          ...new Set(resp.items.map((b) => b.parent_id).filter((id): id is string => id != null)),
        ]
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          if (cancelled) return
          const titleMap = new Map<string, string>()
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? 'Untitled')
          }
          setPageTitles(titleMap)
        }
      } catch {
        // Silently handle errors
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doFetch()
    return () => {
      cancelled = true
    }
  }, [date, sourceFilter])

  // Fetch projected entries for repeating tasks
  useEffect(() => {
    let stale = false
    setProjectedLoading(true)
    listProjectedAgenda({ startDate: date, endDate: date, limit: 20 })
      .then((entries) => {
        if (!stale) {
          setProjectedEntries(entries)
          const parentIds = entries
            .map((e) => e.block.parent_id)
            .filter((id): id is string => id != null)
          if (parentIds.length > 0) {
            batchResolve(parentIds).then((resolved) => {
              if (!stale) {
                setPageTitles((prev) => {
                  const next = new Map(prev)
                  for (const r of resolved) {
                    next.set(r.id, r.title ?? 'Untitled')
                  }
                  return next
                })
              }
            }).catch(() => {})
          }
        }
      })
      .catch(() => {
        if (!stale) setProjectedEntries([])
      })
      .finally(() => {
        if (!stale) setProjectedLoading(false)
      })
    return () => { stale = true }
  }, [date])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const handleBlockClick = useCallback(
    (block: BlockRow) => {
      const parentId = block.parent_id
      if (parentId) {
        const title = pageTitles.get(parentId) ?? 'Untitled'
        onNavigateToPage?.(parentId, title, block.id)
      }
    },
    [onNavigateToPage, pageTitles],
  )

  const handleBlockKeyDown = useCallback(
    (e: React.KeyboardEvent, block: BlockRow) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleBlockClick(block)
      }
    },
    [handleBlockClick],
  )

  // Group blocks by todo_state in the defined order, sorted by priority within
  const groupLabels: Record<string, string> = {
    DOING: t('duePanel.groupDoing'),
    TODO: t('duePanel.groupTodo'),
    DONE: t('duePanel.groupDone'),
  }
  const grouped = GROUP_ORDER.map((state) => {
    const items = blocks
      .filter((b) => b.todo_state === state)
      .sort((a, b) => priorityKey(a.priority) - priorityKey(b.priority))
    return { state, label: state ? (groupLabels[state] ?? state) : t('duePanel.groupOther'), items }
  }).filter((g) => g.items.length > 0)

  // Empty state: hidden entirely
  if (!loading && !projectedLoading && totalCount === 0 && blocks.length === 0 && projectedEntries.length === 0) {
    return null
  }

  const headerLabel =
    totalCount === 1 ? t('duePanel.headerOne') : t('duePanel.header', { count: totalCount })

  return (
    <section className="due-panel" aria-label="Due items">
      {/* Main header -- collapsible */}
      <button
        type="button"
        onClick={toggleCollapsed}
        className="due-panel-header flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
        aria-expanded={!collapsed}
      >
        {!collapsed ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        {headerLabel}
      </button>

      {!collapsed && (
        <div className="due-panel-filters flex items-center gap-1 px-2 py-1">
          {[
            { label: t('duePanel.filterAll'), value: null },
            { label: t('duePanel.filterDue'), value: 'column:due_date' },
            { label: t('duePanel.filterScheduled'), value: 'column:scheduled_date' },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
                sourceFilter === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
              onClick={() => {
                setSourceFilter(opt.value)
              }}
              aria-pressed={sourceFilter === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {!collapsed && (
        <div className="due-panel-content mt-1 space-y-2">
          {/* Loading spinner */}
          {loading && blocks.length === 0 && (
            <div
              className="due-panel-loading flex items-center gap-2 px-2 py-2"
              aria-busy="true"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" data-testid="loader-spinner" />
              <span className="text-sm text-muted-foreground">{t('duePanel.loading')}</span>
            </div>
          )}

          {/* Grouped blocks */}
          {grouped.map((group) => (
            <div key={group.label} className="due-panel-group">
              {/* Group sub-header (not collapsible) */}
              <div className="due-panel-group-header px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wide">
                {group.label}
              </div>

              <ul className="due-panel-blocks ml-2 space-y-1" aria-label={`${group.label} items`}>
                {group.items.map((block) => (
                  <li
                    key={block.id}
                    className="due-panel-item flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                    tabIndex={0}
                    onClick={() => handleBlockClick(block)}
                    onKeyDown={(e) => handleBlockKeyDown(e, block)}
                  >
                    {/* Priority badge */}
                    {block.priority && (
                      <span
                        className={`due-panel-priority inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold ${priorityColor(block.priority)}`}
                      >
                        P{block.priority}
                      </span>
                    )}

                    {/* Block content */}
                    <span className="due-panel-item-text text-sm flex-1 truncate">
                      {truncateContent(block.content)}
                    </span>

                    {/* Source page breadcrumb */}
                    {block.parent_id && (
                      <span className="due-panel-breadcrumb text-xs text-muted-foreground shrink-0">
                        {t('duePanel.breadcrumbArrow')}{' '}
                        {pageTitles.get(block.parent_id) ?? t('duePanel.untitled')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Projected future occurrences from repeating tasks */}
          {projectedEntries.length > 0 && (
            <div className="mt-3 border-t border-dashed border-muted-foreground/30 pt-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                {t('due.projected', { defaultValue: 'Projected' })}
              </p>
              <ul className="space-y-1">
                {projectedEntries.map((entry) => (
                  <li
                    key={`projected-${entry.block.id}-${entry.source}`}
                    className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:bg-muted/50 transition-colors"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!entry.block.parent_id || !onNavigateToPage) return
                      const title = pageTitles.get(entry.block.parent_id) ?? ''
                      onNavigateToPage(entry.block.parent_id, title, entry.block.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      if (!entry.block.parent_id || !onNavigateToPage) return
                      const title = pageTitles.get(entry.block.parent_id) ?? ''
                      onNavigateToPage(entry.block.parent_id, title, entry.block.id)
                    }}
                  >
                    <span className="text-xs font-mono opacity-60">
                      {entry.source === 'due_date' ? '\u23F0' : '\uD83D\uDCC5'}
                    </span>
                    <span className="flex-1 truncate">
                      {truncateContent(entry.block.content, 80)}
                    </span>
                    {entry.block.priority && (
                      <span className={cn(
                        'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-bold leading-none',
                        priorityColor(entry.block.priority),
                      )}>
                        P{entry.block.priority}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Load more */}
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="due-panel-load-more w-full"
              onClick={loadMore}
              disabled={loading}
              aria-busy={loading}
              aria-label={loading ? t('duePanel.loadingMore') : t('duePanel.loadMoreLabel')}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t('duePanel.loading')}
                </>
              ) : (
                t('duePanel.loadMore')
              )}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
