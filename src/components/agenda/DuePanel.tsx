/**
 * DuePanel -- shows blocks due on a given date, grouped by todo_state.
 *
 * Renders on JournalPage. Groups blocks by todo_state in order:
 * DOING > TODO > DONE > null (Other). Within each group, sorts by
 * the configurable priority rank (`priorityRank` from
 * `@/lib/priority-levels`) so the order follows the user's configured
 * levels, with null/unknown sorting last. Uses cursor-based pagination
 * with a `t('duePanel.loadMore')` button.
 *
 * Orchestrator that connects useDuePanelData to extracted section
 * components (OverdueSection, UpcomingSection, DuePanelFilters).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { Repeat } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DuePanelFilters } from '@/components/agenda/DuePanelFilters'
import { OverdueSection } from '@/components/agenda/OverdueSection'
import { UpcomingSection } from '@/components/agenda/UpcomingSection'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Badge } from '@/components/ui/badge'
import { ListItem } from '@/components/ui/list-item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionGroupHeader } from '@/components/ui/section-group-header'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useDuePanelData } from '@/hooks/useDuePanelData'
import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useToday } from '@/hooks/useToday'
import type { NavigateToPageFn } from '@/lib/block-events'
import { priorityRank } from '@/lib/priority-levels'
import { cn } from '@/lib/utils'

export interface DuePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: NavigateToPageFn | undefined
  /**
   * Journal day's own page id. Agenda items that live on that page are
   * excluded so a todo written in today's note isn't shown twice — once
   * in the note body, once in the Agenda list (UX live-review #7).
   */
  excludePageId?: string | undefined
}

// #738 sub-1 — CANCELLED was absent here, so a CANCELLED block matched
// no group (hidden from the list) yet still counted in `visibleBlocks`,
// making the header say "3 due" while the list showed 2. Adding the
// group keeps the header count and rendered rows in agreement and
// matches the canonical agenda grouping (`agenda-sort.ts`: DOING > TODO
// > DONE > CANCELLED > null) and the existing DONE precedent.
const GROUP_ORDER = ['DOING', 'TODO', 'DONE', 'CANCELLED', null] as const

export function DuePanel({
  date,
  onNavigateToPage,
  excludePageId,
}: DuePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const priorityLevels = usePriorityLevels()
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
  } = useDuePanelData({ date, sourceFilter, excludePageId })

  const todayStr = useToday()

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const { handleBlockClick, getRowHandlers } = useBlockNavigation({
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

  // #1540 — Date-equality breakdown heuristic, NOT an authoritative per-source
  // tally. The backend selects agenda blocks by `agendaSource` (due / scheduled
  // / arbitrary date properties) and returns them as a flat array with no
  // per-block source tag, so the panel cannot recover which source actually
  // matched each block. We instead classify by date equality in priority order
  // (due > scheduled > property): a block with `due_date === date` is bucketed
  // as "due" even if it was selected by a date property, and a block with both
  // dates equal to `date` counts once, as "due". The buckets are therefore an
  // approximate breakdown of the visible set, not a reconstruction of the
  // backend's selection — treat the three numbers as a date-based summary that
  // always sums to `visibleBlocks.length`.
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

  // Group blocks for display (computed early so flatItems can be derived).
  // FE-H-19: memoized to keep reference-stable across renders — otherwise the
  // `flatItems` memo below would recompute every render because `grouped`
  // would change identity, which would in turn reset keyboard-nav focus.
  // `groupLabels` is kept inside the memo so it isn't a per-render dep.
  const grouped = useMemo(() => {
    const groupLabels: Record<string, string> = {
      DOING: t('duePanel.groupDoing'),
      TODO: t('duePanel.groupTodo'),
      DONE: t('duePanel.groupDone'),
      CANCELLED: t('duePanel.groupCancelled'),
    }
    return GROUP_ORDER.map((state) => {
      const items = visibleBlocks
        .filter((b) => b.todo_state === state)
        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
      return {
        state,
        label: state ? (groupLabels[state] ?? state) : t('duePanel.groupOther'),
        items,
      }
    }).filter((g) => g.items.length > 0)
    // `priorityLevels` is an intentional re-sort trigger: `priorityRank` reads the
    // configured levels from module state (not a captured variable), so it isn't
    // referenced directly in the callback, but the memo MUST recompute when the
    // user changes levels or the group keeps its stale order.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional re-sort trigger (see above)
  }, [visibleBlocks, t, priorityLevels])

  // Deduplicate: exclude projected entries whose block already appears in real
  // agenda. Computed once here so the result is shared by the keyboard nav
  // flat-items array AND the rendered projected `<li>`s (UX-274).
  const uniqueProjected = useMemo(() => {
    const realBlockIds = new Set(blocks.map((b) => b.id))
    return projectedEntries.filter((e) => !realBlockIds.has(e.block.id))
  }, [blocks, projectedEntries])

  // Flat-items array threads grouped blocks AND projected entries so arrow-key
  // navigation can reach the projected `<li>` items at the bottom of the list.
  // FE-H-19: memoized to keep reference-stable across renders — otherwise the
  // keyboard-nav `itemCount` / `onSelect` reads below recompute on every parent
  // render, invalidating effects that depend on `flatItems` identity.
  const flatItems = useMemo(
    () => [...grouped.flatMap((g) => g.items), ...uniqueProjected.map((e) => e.block)],
    [grouped, uniqueProjected],
  )

  const {
    focusedIndex,
    handleKeyDown: navHandleKeyDown,
    listRef,
  } = useKeyboardNavigableList<HTMLDivElement>(
    flatItems.length,
    (idx) => {
      const block = flatItems[idx]
      if (block) handleBlockClick(block)
    },
    {
      homeEnd: true,
      pageUpDown: true,
      // Composite signature so any of the three filter/date inputs reset focus.
      resetKey: `${sourceFilter ?? ''}|${hideBeforeScheduled}|${date}`,
    },
  )

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14) ─────────────
  // The grouped-blocks section is flattened into a single row list of
  // `{ kind: 'group-header' | 'item', ... }` so the virtualizer can
  // drop offscreen groups in their entirety instead of mounting every
  // sub-list. Overdue / Upcoming / projected entries stay
  // un-virtualized — they're rendered outside the virtualizer and
  // their item counts are small (overdue/upcoming caps at PAGINATION,
  // projected is bounded by repeat-projection horizon). The grouped
  // section is the only `.map((g) => g.items.map((b) => ...))` chain
  // that the audit flagged (line 292).
  // `flatItemIndex` indexes the grouped-blocks portion of `flatItems`
  // (= `grouped.flatMap(g => g.items)`); the projected portion sits at
  // tail indices and is keyboard-navigable via its own `<li>` markup
  // below, so this map only needs to cover the grouped portion.
  type VirtualRow =
    | { kind: 'group-header'; key: string; label: string }
    | {
        kind: 'item'
        key: string
        block: (typeof grouped)[number]['items'][number]
        flatItemIndex: number
      }

  const virtualRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = []
    let flatIdx = 0
    for (const group of grouped) {
      rows.push({
        kind: 'group-header',
        key: `header:${group.label}`,
        label: group.label,
      })
      for (const block of group.items) {
        rows.push({
          kind: 'item',
          key: block.id,
          block,
          flatItemIndex: flatIdx++,
        })
      }
    }
    return rows
  }, [grouped])

  const scrollParentRef = useRef<HTMLDivElement>(null)

  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (row?.kind === 'group-header') return 32
      return 44
    },
    [virtualRows],
  )

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => virtualRows[index]?.key ?? index,
  })

  const flatToVirtualIndex = useMemo(() => {
    const map: number[] = []
    virtualRows.forEach((row, idx) => {
      if (row.kind === 'item') map[row.flatItemIndex] = idx
    })
    return map
  }, [virtualRows])

  useEffect(() => {
    if (focusedIndex < 0) return
    const idx = flatToVirtualIndex[focusedIndex]
    if (idx == null) return
    virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [focusedIndex, virtualizer, flatToVirtualIndex])

  // UX-152: Don't render when ALL sources are empty (not loading).
  // When a source filter is active, always keep the panel visible so the
  // user can switch back to `t('duePanel.filterAll')` — otherwise the filter pills vanish.
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
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> defaults to display:inline and would break this flex skeleton container; keep role="status" on the div
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
            // Projected entries sit after grouped blocks in the
            // keyboard-nav `flatItems` array (see `flatItems` memo
            // above). The grouped portion now lives inside the
            // virtualizer (which tracks its own `flatItemIndex` per
            // row); the projected `<li>` markup below picks up where
            // grouped left off.
            const groupedCount = grouped.reduce((sum, g) => sum + g.items.length, 0)
            let flatIndex = groupedCount
            return (
              // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container
              <div
                className="due-panel-content mt-1 space-y-2"
                ref={listRef}
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard nav container
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

                {/* Grouped blocks (virtualized — perf-review Tier 2 #6).
                    A single `<ul>` parent holds both group-header `<li>`s
                    and item `<li>`s (the latter rendered by
                    `BlockListItem`). Flat-list virtualization lets the
                    windowing skip offscreen groups entirely instead of
                    mounting every sub-list. */}
                {virtualRows.length > 0 && (
                  <ScrollArea
                    viewportRef={scrollParentRef}
                    viewportClassName="due-panel-scroll max-h-[calc(100dvh-260px)] pr-2.5"
                  >
                    <ul
                      className="due-panel-blocks relative m-0 p-0 list-none"
                      style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                      {virtualizer.getVirtualItems().map((virtualRow) => {
                        const row = virtualRows[virtualRow.index]
                        if (!row) return null
                        const rowStyle: React.CSSProperties = {
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }
                        if (row.kind === 'group-header') {
                          return (
                            <li
                              key={virtualRow.key}
                              data-index={virtualRow.index}
                              ref={virtualizer.measureElement}
                              style={rowStyle}
                              className="due-panel-group-header-row"
                            >
                              <SectionGroupHeader className="due-panel-group-header">
                                {row.label}
                              </SectionGroupHeader>
                            </li>
                          )
                        }
                        // Tier 1.4: stable per-block handlers.
                        const block = row.block
                        const rowHandlers = getRowHandlers(block)
                        return (
                          <BlockListItem
                            key={virtualRow.key}
                            liRef={virtualizer.measureElement}
                            dataIndex={virtualRow.index}
                            style={rowStyle}
                            blockId={block.id}
                            content={block.content}
                            contentMaxLength={120}
                            emptyContentFallback={t('duePanel.emptyContent')}
                            // Typed metadata primitives — `BlockListItem`
                            // renders the priority badge internally so the
                            // memo shallow-compare hits cleanly across
                            // parent re-renders (perf-review Tier 1.4
                            // metadata half, 2026-05-14).
                            priority={block.priority}
                            priorityBadgeClassName="due-panel-priority [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1"
                            pageId={block.page_id}
                            pageTitle={
                              block.page_id
                                ? (pageTitles.get(block.page_id) ?? t('duePanel.untitled'))
                                : ''
                            }
                            breadcrumbArrow={t('duePanel.breadcrumbArrow')}
                            className="due-panel-item hover:bg-muted/50 active:bg-muted/70 ml-2"
                            contentClassName="due-panel-item-text"
                            breadcrumbClassName="due-panel-breadcrumb"
                            testId="due-panel-item"
                            onClick={rowHandlers.onClick}
                            onKeyDown={rowHandlers.onKeyDown}
                            isFocused={focusedIndex === row.flatItemIndex}
                          />
                        )
                      })}
                    </ul>
                  </ScrollArea>
                )}

                {/* Projected future occurrences from repeating tasks.
                    UX-274: each `<li>` is part of the keyboard-nav flat-items
                    array so arrow keys reach projected entries at the tail. */}
                {uniqueProjected.length > 0 && (
                  <div className="mt-3 border-t border-dashed border-muted-foreground/30 pt-3">
                    <p className="text-xs [@media(pointer:coarse)]:text-sm font-medium text-muted-foreground mb-2">
                      {t('due.projected')}
                    </p>
                    <ul className="space-y-1" aria-label={t('duePanel.projectedListLabel')}>
                      {uniqueProjected.map((entry) => {
                        const currentFlatIndex = flatIndex++
                        const projectedFocused = focusedIndex === currentFlatIndex
                        return (
                          <ListItem
                            key={`projected-${entry.block.id}-${entry.source}`}
                            data-block-list-item
                            data-testid="projected-entry"
                            tabIndex={0}
                            className={cn(
                              // Override ListItem's `gap-3 rounded-lg px-3 py-2 hover:bg-accent/50` chrome
                              // with the muted dashed-border "projected" shape via tailwind-merge.
                              'gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:bg-muted/50 active:bg-muted/70',
                              projectedFocused && 'ring-2 ring-inset ring-ring/50 bg-accent/30',
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
                            <Badge tone="outline" className="text-xs font-normal">
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
                              <Badge
                                tone="priority"
                                shape="rounded"
                                size="sm"
                                priorityLevel={entry.block.priority}
                              >
                                P{entry.block.priority}
                              </Badge>
                            )}
                          </ListItem>
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
