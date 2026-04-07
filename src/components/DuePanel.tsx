/**
 * DuePanel -- shows blocks due on a given date, grouped by todo_state.
 *
 * Renders on JournalPage. Groups blocks by todo_state in order:
 * DOING > TODO > DONE > null (Other). Within each group, sorts by
 * priority: 1 > 2 > 3 > null. Uses cursor-based pagination with
 * "Load more" button.
 *
 * Orchestrator that connects useDuePanelData to extracted section
 * components (OverdueSection, UpcomingSection, DuePanelFilters).
 */

import { CheckCircle2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { getTodayString } from '@/lib/date-utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useDuePanelData } from '../hooks/useDuePanelData'
import type { NavigateToPageFn } from '../lib/block-events'
import { truncateContent } from '../lib/text-utils'
import { BlockListItem } from './BlockListItem'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { DuePanelFilters } from './DuePanelFilters'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { OverdueSection } from './OverdueSection'
import { UpcomingSection } from './UpcomingSection'
import { PriorityBadge } from './ui/priority-badge'

export interface DuePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: NavigateToPageFn | undefined
}

const GROUP_ORDER = ['DOING', 'TODO', 'DONE', null] as const

/** Priority sort key: '1' → 1, '2' → 2, '3' → 3, null → 4 */
function priorityKey(p: string | null): number {
  if (p === '1') return 1
  if (p === '2') return 2
  if (p === '3') return 3
  return 4
}

export function DuePanel({ date, onNavigateToPage }: DuePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)

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

  const {
    blocks,
    loading,
    hasMore,
    pageTitles,
    projectedEntries,
    projectedLoading,
    overdueBlocks,
    upcomingBlocks,
    isToday,
    loadMore,
  } = useDuePanelData({ date, sourceFilter })

  const todayStr = useMemo(() => getTodayString(), [])

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

  // Per-source breakdown counts (accurate when sourceFilter is null / 'property:')
  const sourceCounts = useMemo(() => {
    const counts = { due: 0, scheduled: 0, property: 0 }
    for (const b of visibleBlocks) {
      if (b.due_date === date) counts.due++
      else if (b.scheduled_date === date) counts.scheduled++
      else counts.property++
    }
    return counts
  }, [visibleBlocks, date])

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
        <EmptyState icon={CheckCircle2} message={t('duePanel.empty')} compact />
      </section>
    )
  }

  const visibleCount = visibleBlocks.length
  const headerLabel = (() => {
    if (sourceFilter === null && visibleCount > 0) {
      const { due, scheduled, property } = sourceCounts
      const parts: string[] = []
      if (due > 0) parts.push(`${due} ${t('duePanel.filterDue')}`)
      if (scheduled > 0) parts.push(`${scheduled} ${t('duePanel.filterScheduled')}`)
      if (property > 0) parts.push(`${property} ${t('duePanel.filterProperties')}`)
      if (parts.length > 1) return parts.join(' \u00b7 ')
    }
    return visibleCount === 1
      ? t('duePanel.headerOne')
      : t('duePanel.header', { count: visibleCount })
  })()

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
        <DuePanelFilters
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          hideBeforeScheduled={hideBeforeScheduled}
          onToggleHideBeforeScheduled={toggleHideBeforeScheduled}
        />
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
              <LoadingSkeleton count={3} height="h-10" />
            </div>
          )}

          {/* Overdue section */}
          {isToday && (
            <OverdueSection
              blocks={overdueBlocks}
              pageTitles={pageTitles}
              onNavigateToPage={onNavigateToPage}
            />
          )}

          {/* Upcoming section */}
          {isToday && (
            <UpcomingSection
              blocks={upcomingBlocks}
              pageTitles={pageTitles}
              onNavigateToPage={onNavigateToPage}
            />
          )}

          {/* Grouped blocks */}
          {grouped.map((group) => (
            <div key={group.label} className="due-panel-group">
              {/* Group sub-header (not collapsible) */}
              <div className="due-panel-group-header px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wide bg-muted/50 rounded [@media(pointer:coarse)]:text-sm">
                {group.label}
              </div>

              <ul className="due-panel-blocks ml-2 space-y-1" aria-label={`${group.label} items`}>
                {group.items.map((block) => (
                  <BlockListItem
                    key={block.id}
                    content={block.content}
                    contentMaxLength={120}
                    emptyContentFallback={t('duePanel.emptyContent')}
                    metadata={
                      block.priority ? (
                        <PriorityBadge
                          priority={block.priority}
                          className="due-panel-priority [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1"
                        />
                      ) : undefined
                    }
                    pageId={block.parent_id}
                    pageTitle={
                      block.parent_id
                        ? (pageTitles.get(block.parent_id) ?? t('duePanel.untitled'))
                        : ''
                    }
                    breadcrumbArrow={t('duePanel.breadcrumbArrow')}
                    className="due-panel-item hover:bg-muted/50 active:bg-muted/70"
                    contentClassName="due-panel-item-text"
                    breadcrumbClassName="due-panel-breadcrumb"
                    testId="due-panel-item"
                    onClick={() => handleBlockClick(block)}
                    onKeyDown={(e) => handleBlockKeyDown(e, block)}
                  />
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
                      {entry.block.priority && <PriorityBadge priority={entry.block.priority} />}
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
