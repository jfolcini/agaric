/**
 * DuePanel -- shows blocks due on a given date, grouped by todo_state.
 *
 * Renders on JournalPage. Groups blocks by todo_state in order:
 * DOING > TODO > DONE > null (Other). Within each group, sorts by
 * priority: 1 > 2 > 3 > null. Uses cursor-based pagination with
 * "Load more" button.
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { priorityColor } from '../lib/priority-color'
import type { BlockRow, ProjectedAgendaEntry } from '../lib/tauri'
import { batchResolve, listBlocks, listProjectedAgenda, queryByProperty } from '../lib/tauri'
import { truncateContent } from '../lib/text-utils'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { LoadMoreButton } from './LoadMoreButton'
import { PageLink } from './PageLink'

export interface DuePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: ((pageId: string, title: string, blockId?: string) => void) | undefined
}

const GROUP_ORDER = ['DOING', 'TODO', 'DONE', null] as const

/** Priority sort key: '1' → 1, '2' → 2, '3' → 3, null → 4 */
function priorityKey(p: string | null): number {
  if (p === '1') return 1
  if (p === '2') return 2
  if (p === '3') return 3
  return 4
}

/** Format a Date to YYYY-MM-DD using local timezone. */
function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  const [overdueBlocks, setOverdueBlocks] = useState<BlockRow[]>([])
  const [upcomingBlocks, setUpcomingBlocks] = useState<BlockRow[]>([])

  const warningDays = useMemo(() => {
    try {
      const stored = localStorage.getItem('agaric:deadlineWarningDays')
      return stored ? Number.parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  }, [])

  const [hideBeforeScheduled, setHideBeforeScheduled] = useState(() => {
    try {
      return localStorage.getItem('agaric:hideBeforeScheduled') === 'true'
    } catch {
      return false
    }
  })

  const toggleHideBeforeScheduled = useCallback(() => {
    setHideBeforeScheduled((prev) => {
      const next = !prev
      try {
        localStorage.setItem('agaric:hideBeforeScheduled', String(next))
      } catch {}
      return next
    })
  }, [])

  const todayStr = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])
  const isToday = date === todayStr

  // Fetch overdue blocks when showing today
  useEffect(() => {
    if (!isToday) {
      setOverdueBlocks([])
      return
    }
    let stale = false

    async function fetchOverdue() {
      try {
        const resp = await queryByProperty({ key: 'due_date', limit: 500 })
        if (stale) return

        const overdue = resp.items.filter(
          (b) => b.due_date && b.due_date < date && b.todo_state !== 'DONE',
        )
        setOverdueBlocks(overdue)

        if (overdue.length > 0) {
          const parentIds = overdue.map((b) => b.parent_id).filter((id): id is string => id != null)
          if (parentIds.length > 0) {
            const resolved = await batchResolve([...new Set(parentIds)])
            if (!stale) {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of resolved) {
                  next.set(r.id, r.title ?? 'Untitled')
                }
                return next
              })
            }
          }
        }
      } catch {
        if (!stale) setOverdueBlocks([])
      }
    }

    fetchOverdue()
    return () => {
      stale = true
    }
  }, [isToday, date])

  // Fetch upcoming blocks (deadline approaching within warningDays)
  useEffect(() => {
    if (!isToday || warningDays <= 0) {
      setUpcomingBlocks([])
      return
    }
    let stale = false

    async function fetchUpcoming() {
      try {
        const resp = await queryByProperty({ key: 'due_date', limit: 500 })
        if (stale) return

        // Filter: due_date is between tomorrow and today + warningDays
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        const tomorrowStr = formatLocalDate(tomorrow)

        const endDate = new Date()
        endDate.setDate(endDate.getDate() + warningDays)
        const endStr = formatLocalDate(endDate)

        const upcoming = resp.items.filter(
          (b) =>
            b.due_date &&
            b.due_date >= tomorrowStr &&
            b.due_date <= endStr &&
            b.todo_state !== 'DONE',
        )
        setUpcomingBlocks(upcoming)

        // Resolve parent titles
        if (upcoming.length > 0) {
          const parentIds = upcoming
            .map((b) => b.parent_id)
            .filter((id): id is string => id != null)
          if (parentIds.length > 0) {
            const titles = await batchResolve([...new Set(parentIds)])
            if (!stale) {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of titles) {
                  if (r.title) next.set(r.id, r.title)
                }
                return next
              })
            }
          }
        }
      } catch {
        if (!stale) setUpcomingBlocks([])
      }
    }

    fetchUpcoming()
    return () => {
      stale = true
    }
  }, [isToday, warningDays])

  // Fetch blocks due on the given date
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await listBlocks({
          agendaDate: date,
          ...(sourceFilter != null && { agendaSource: sourceFilter }),
          ...(cursor != null && { cursor }),
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
          ...(sourceFilter != null && { agendaSource: sourceFilter }),
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
            batchResolve(parentIds)
              .then((resolved) => {
                if (!stale) {
                  setPageTitles((prev) => {
                    const next = new Map(prev)
                    for (const r of resolved) {
                      next.set(r.id, r.title ?? 'Untitled')
                    }
                    return next
                  })
                }
              })
              .catch(() => toast.error(t('duePanel.loadAgendaFailed')))
          }
        }
      })
      .catch(() => {
        if (!stale) setProjectedEntries([])
        toast.error(t('duePanel.loadAgendaFailed'))
      })
      .finally(() => {
        if (!stale) setProjectedLoading(false)
      })
    return () => {
      stale = true
    }
  }, [date, t])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: 'Untitled',
  })

  // Filter out future-scheduled blocks when toggle is ON
  const visibleBlocks = useMemo(() => {
    if (!hideBeforeScheduled) return blocks
    return blocks.filter((b) => {
      if (b.scheduled_date && b.scheduled_date > todayStr) return false
      return true
    })
  }, [blocks, hideBeforeScheduled, todayStr])

  // Group blocks by todo_state in the defined order, sorted by priority within
  const groupLabels: Record<string, string> = {
    DOING: t('duePanel.groupDoing'),
    TODO: t('duePanel.groupTodo'),
    DONE: t('duePanel.groupDone'),
  }
  const grouped = GROUP_ORDER.map((state) => {
    const items = visibleBlocks
      .filter((b) => b.todo_state === state)
      .sort((a, b) => priorityKey(a.priority) - priorityKey(b.priority))
    return { state, label: state ? (groupLabels[state] ?? state) : t('duePanel.groupOther'), items }
  }).filter((g) => g.items.length > 0)

  // Empty state: show message instead of hiding entirely
  if (
    !loading &&
    !projectedLoading &&
    visibleBlocks.length === 0 &&
    blocks.length === 0 &&
    projectedEntries.length === 0 &&
    overdueBlocks.length === 0 &&
    upcomingBlocks.length === 0
  ) {
    return (
      <section className="due-panel" aria-label={t('duePanel.duePanelLabel')}>
        <p className="text-sm text-muted-foreground px-4 py-8 text-center">{t('duePanel.empty')}</p>
      </section>
    )
  }

  const visibleCount = visibleBlocks.length
  const headerLabel =
    visibleCount === 1 ? t('duePanel.headerOne') : t('duePanel.header', { count: visibleCount })

  return (
    <section className="due-panel" aria-label={t('duePanel.duePanelLabel')}>
      {/* Main header -- collapsible */}
      <CollapsiblePanelHeader
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        className="due-panel-header"
      >
        {headerLabel}
      </CollapsiblePanelHeader>

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
                'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
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
          <button
            type="button"
            className={cn(
              'text-xs px-1.5 py-0.5 rounded border transition-colors',
              hideBeforeScheduled
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-muted-foreground/20 text-muted-foreground hover:bg-accent/50',
            )}
            onClick={toggleHideBeforeScheduled}
            title={
              hideBeforeScheduled
                ? t('duePanel.showingScheduledTodayTooltip')
                : t('duePanel.showingAllTasksTooltip')
            }
            aria-pressed={hideBeforeScheduled}
          >
            {hideBeforeScheduled
              ? t('duePanel.scheduledHideFutureButton')
              : t('duePanel.scheduledShowAllButton')}
          </button>
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

          {/* Overdue section */}
          {isToday && overdueBlocks.length > 0 && (
            <div className="overdue-section mb-3">
              <h4 className="text-xs font-semibold text-destructive mb-1.5 flex items-center gap-1">
                <span>{t('duePanel.overdueTitle')}</span>
                <span className="text-muted-foreground font-normal">({overdueBlocks.length})</span>
              </h4>
              <ul className="space-y-1">
                {overdueBlocks
                  .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
                  .map((block) => {
                    const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
                    return (
                      <li
                        key={`overdue-${block.id}`}
                        className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-sm cursor-pointer hover:bg-destructive/10 transition-colors"
                        onClick={() => {
                          if (block.parent_id && onNavigateToPage) {
                            onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          if (block.parent_id && onNavigateToPage) {
                            onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                          }
                        }}
                      >
                        {block.todo_state && (
                          <span className="shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                            {block.todo_state}
                          </span>
                        )}
                        {block.priority && (
                          <span
                            className={cn(
                              'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
                              priorityColor(block.priority),
                            )}
                          >
                            P{block.priority}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                        </span>
                        <span className="shrink-0 text-xs text-destructive/60">
                          {block.due_date}
                        </span>
                      </li>
                    )
                  })}
              </ul>
            </div>
          )}

          {/* Upcoming section */}
          {isToday && upcomingBlocks.length > 0 && (
            <div className="upcoming-section mb-3">
              <h4 className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1.5 flex items-center gap-1">
                <span>{t('duePanel.upcomingTitle')}</span>
                <span className="text-muted-foreground font-normal">({upcomingBlocks.length})</span>
              </h4>
              <ul className="space-y-1">
                {upcomingBlocks
                  .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
                  .map((block) => {
                    const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
                    return (
                      <li
                        key={`upcoming-${block.id}`}
                        className="flex items-center gap-2 rounded-md border border-amber-200/30 bg-amber-50/30 dark:border-amber-800/30 dark:bg-amber-950/20 px-2 py-1.5 text-sm cursor-pointer hover:bg-amber-50/50 dark:hover:bg-amber-950/30 transition-colors"
                        onClick={() => {
                          if (block.parent_id && onNavigateToPage)
                            onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          if (block.parent_id && onNavigateToPage)
                            onNavigateToPage(block.parent_id, pageTitle ?? '', block.id)
                        }}
                      >
                        {block.todo_state && (
                          <span className="shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                            {block.todo_state}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                        </span>
                        <span className="shrink-0 text-xs text-amber-600/60 dark:text-amber-400/60">
                          {block.due_date}
                        </span>
                      </li>
                    )
                  })}
              </ul>
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
                    className="due-panel-item flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 active:bg-muted/70 transition-colors"
                    data-testid="due-panel-item"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                    tabIndex={0}
                    onClick={() => handleBlockClick(block)}
                    onKeyDown={(e) => handleBlockKeyDown(e, block)}
                  >
                    {/* Priority badge */}
                    {block.priority && (
                      <span
                        className={`due-panel-priority inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1 ${priorityColor(block.priority)}`}
                      >
                        P{block.priority}
                      </span>
                    )}

                    {/* Block content */}
                    <span className="due-panel-item-text text-sm min-w-0 flex-1 truncate">
                      {truncateContent(block.content, 120, t('duePanel.emptyContent'))}
                    </span>

                    {/* Source page breadcrumb */}
                    {block.parent_id && (
                      <span className="due-panel-breadcrumb text-xs text-muted-foreground truncate max-w-[40%]">
                        {t('duePanel.breadcrumbArrow')}{' '}
                        <PageLink
                          pageId={block.parent_id}
                          title={pageTitles.get(block.parent_id) ?? t('duePanel.untitled')}
                        />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Projected future occurrences from repeating tasks */}
          {(() => {
            // Deduplicate: exclude projected entries whose block already appears in real agenda
            const realBlockIds = new Set(blocks.map((b) => b.id))
            const uniqueProjected = projectedEntries.filter((e) => !realBlockIds.has(e.block.id))
            return uniqueProjected.length > 0 ? (
              <div className="mt-3 border-t border-dashed border-muted-foreground/30 pt-3">
                <p className="text-xs [@media(pointer:coarse)]:text-sm font-medium text-muted-foreground mb-2">
                  {t('due.projected', { defaultValue: 'Projected' })}
                </p>
                <ul className="space-y-1">
                  {uniqueProjected.map((entry) => (
                    <li
                      key={`projected-${entry.block.id}-${entry.source}`}
                      className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:bg-muted/50 active:bg-muted/70 transition-colors"
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
                      <span className="min-w-0 flex-1 truncate">
                        {truncateContent(entry.block.content, 80, t('duePanel.emptyContent'))}
                      </span>
                      {entry.block.priority && (
                        <span
                          className={cn(
                            'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
                            priorityColor(entry.block.priority),
                          )}
                        >
                          P{entry.block.priority}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          })()}

          {/* Load more */}
          <LoadMoreButton
            hasMore={hasMore}
            loading={loading}
            onLoadMore={loadMore}
            className="due-panel-load-more"
            label={t('duePanel.loadMore')}
            loadingLabel={t('duePanel.loading')}
            ariaLabel={t('duePanel.loadMoreLabel')}
            ariaLoadingLabel={t('duePanel.loadingMore')}
          />
        </div>
      )}
    </section>
  )
}
