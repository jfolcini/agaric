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

import { Repeat } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useDuePanelData } from '../hooks/useDuePanelData'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import type { NavigateToPageFn } from '../lib/block-events'
import { BlockListItem } from './BlockListItem'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { DuePanelFilters } from './DuePanelFilters'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'
import { OverdueSection } from './OverdueSection'
import { renderRichContent } from './StaticBlock'
import { UpcomingSection } from './UpcomingSection'
import { Badge } from './ui/badge'
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
  const callbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()
  const [collapsed, setCollapsed] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)

  // On-disk format is the bare boolean (`'true'` / `'false'`); JSON.parse
  // and JSON.stringify both round-trip these values, so the default
  // parse/serialize keep wire-format compatibility.
  const [hideBeforeScheduled, setHideBeforeScheduled] = useLocalStoragePreference<boolean>(
    'agaric:hideBeforeScheduled',
    false,
    { source: 'DuePanel' },
  )

  const toggleHideBeforeScheduled = useCallback(() => {
    setHideBeforeScheduled((prev) => !prev)
  }, [setHideBeforeScheduled])

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
    untitledLabel: t('block.untitled'),
  })

  // Filter out future-scheduled blocks when toggle is ON
  const visibleBlocks = useMemo(() => {
    if (!hideBeforeScheduled) return blocks
    return blocks.filter((b) => {
      if (b.scheduled_date && b.scheduled_date > todayStr) return false
      return true
    })
  }, [blocks, hideBeforeScheduled, todayStr])

  // Combined items array for ListViewState empty detection
  const allDisplayItems = useMemo(
    () => [...blocks, ...overdueBlocks, ...upcomingBlocks, ...projectedEntries] as unknown[],
    [blocks, overdueBlocks, upcomingBlocks, projectedEntries],
  )

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

  // ── Keyboard navigation (UX-138) ────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null)

  // Group blocks for display (computed early so flatItems can be derived)
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

  // Deduplicate: exclude projected entries whose block already appears in real
  // agenda. Computed once here so the result is shared by the keyboard nav
  // flat-items array AND the rendered projected `<li>`s (UX-274).
  const uniqueProjected = useMemo(() => {
    const realBlockIds = new Set(blocks.map((b) => b.id))
    return projectedEntries.filter((e) => !realBlockIds.has(e.block.id))
  }, [blocks, projectedEntries])

  // Flat-items array threads grouped blocks AND projected entries so arrow-key
  // navigation can reach the projected `<li>` items at the bottom of the list.
  const flatItems = [...grouped.flatMap((g) => g.items), ...uniqueProjected.map((e) => e.block)]

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: flatItems.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = flatItems[idx]
      if (block) handleBlockClick(block)
    },
  })

  // Reset focused index when filters / date change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [sourceFilter, hideBeforeScheduled, date, setFocusedIndex])

  // Scroll focused item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-block-list-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [focusedIndex])

  // UX-152: Don't render when ALL sources are empty (not loading).
  // When a source filter is active, always keep the panel visible so the
  // user can switch back to "All" — otherwise the filter pills vanish.
  if (!loading && !projectedLoading && allDisplayItems.length === 0 && sourceFilter === null) {
    return null
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
    <section className="due-panel" aria-label={t('duePanel.duePanelLabel')} data-testid="due-panel">
      {/* Main header -- collapsible, always visible */}
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={toggleCollapsed}
        className="due-panel-header"
        testId="due-panel-header"
      >
        {headerLabel}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <DuePanelFilters
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          hideBeforeScheduled={hideBeforeScheduled}
          onToggleHideBeforeScheduled={toggleHideBeforeScheduled}
          sourceCounts={sourceCounts}
        />
      )}

      {!collapsed && (
        <ListViewState
          loading={loading || projectedLoading}
          items={allDisplayItems}
          skeleton={
            <div
              className="due-panel-loading flex items-center gap-2 px-2 py-2"
              aria-busy="true"
              role="status"
            >
              <LoadingSkeleton count={3} height="h-10" />
            </div>
          }
          empty={
            sourceFilter !== null ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {t('duePanel.noItemsForFilter')}
              </p>
            ) : null
          }
        >
          {() => {
            let flatIndex = 0
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav container
              <div
                className="due-panel-content mt-1 space-y-2"
                ref={listRef}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard nav container
                tabIndex={0}
                onKeyDown={(e) => {
                  if (navHandleKeyDown(e)) e.preventDefault()
                }}
              >
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

                    <ul
                      className="due-panel-blocks ml-2 space-y-1"
                      aria-label={`${group.label} items`}
                    >
                      {group.items.map((block) => {
                        const currentFlatIndex = flatIndex++
                        return (
                          <BlockListItem
                            key={block.id}
                            blockId={block.id}
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
                            pageId={block.page_id}
                            pageTitle={
                              block.page_id
                                ? (pageTitles.get(block.page_id) ?? t('duePanel.untitled'))
                                : ''
                            }
                            breadcrumbArrow={t('duePanel.breadcrumbArrow')}
                            className="due-panel-item hover:bg-muted/50 active:bg-muted/70"
                            contentClassName="due-panel-item-text"
                            breadcrumbClassName="due-panel-breadcrumb"
                            testId="due-panel-item"
                            onClick={() => handleBlockClick(block)}
                            onKeyDown={(e) => handleBlockKeyDown(e, block)}
                            isFocused={focusedIndex === currentFlatIndex}
                          />
                        )
                      })}
                    </ul>
                  </div>
                ))}

                {/* Projected future occurrences from repeating tasks.
                    UX-274: each `<li>` is part of the keyboard-nav flat-items
                    array so arrow keys reach projected entries at the tail. */}
                {uniqueProjected.length > 0 && (
                  <div className="mt-3 border-t border-dashed border-muted-foreground/30 pt-3">
                    <p className="text-xs [@media(pointer:coarse)]:text-sm font-medium text-muted-foreground mb-2">
                      {t('due.projected', { defaultValue: 'Projected' })}
                    </p>
                    <ul className="space-y-1" aria-label={t('duePanel.projectedListLabel')}>
                      {uniqueProjected.map((entry) => {
                        const currentFlatIndex = flatIndex++
                        const projectedFocused = focusedIndex === currentFlatIndex
                        return (
                          <li
                            key={`projected-${entry.block.id}-${entry.source}`}
                            data-block-list-item
                            data-testid="projected-entry"
                            // biome-ignore lint/a11y/noNoninteractiveTabindex: projected-entry needs to be a keyboard-nav target
                            tabIndex={0}
                            className={cn(
                              'flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:bg-muted/50 active:bg-muted/70 transition-colors',
                              projectedFocused && 'ring-2 ring-ring/50 bg-accent/30',
                            )}
                            onClick={() => {
                              if (!entry.block.page_id || !onNavigateToPage) return
                              const title = pageTitles.get(entry.block.page_id) ?? ''
                              onNavigateToPage(entry.block.page_id, title, entry.block.id)
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter' && e.key !== ' ') return
                              e.preventDefault()
                              if (!entry.block.page_id || !onNavigateToPage) return
                              const title = pageTitles.get(entry.block.page_id) ?? ''
                              onNavigateToPage(entry.block.page_id, title, entry.block.id)
                            }}
                          >
                            <span className="text-xs font-mono opacity-60">
                              {entry.source === 'due_date' ? '\u23F0' : '\uD83D\uDCC5'}
                            </span>
                            <Badge variant="outline" className="text-xs font-normal">
                              <Repeat className="h-3 w-3 mr-1" />
                              {t('duePanel.projectedBadge')}
                            </Badge>
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={entry.block.content ?? ''}
                            >
                              {entry.block.content
                                ? renderRichContent(entry.block.content, {
                                    interactive: true,
                                    onTagClick,
                                    ...callbacks,
                                  })
                                : t('duePanel.emptyContent')}
                            </span>
                            {entry.block.priority && (
                              <PriorityBadge priority={entry.block.priority} />
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}

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
            )
          }}
        </ListViewState>
      )}
    </section>
  )
}
