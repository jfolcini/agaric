/**
 * DuePanel -- the journal day's open tasks.
 *
 * On today's page the tasks sit under tabs All · Overdue · Today · This week ·
 * Later · No date (`task-buckets.ts`), each with its count; All shows every
 * tab's rows under its name. Any other day lists the open tasks dated that day.
 * Each list is flat, by date then priority, and every row keeps its due or
 * scheduled chip and its page. Uses cursor-based pagination for the day's own
 * rows with a `t('duePanel.loadMore')` button.
 */

import { endOfWeek } from 'date-fns'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ProjectedEntriesSection } from '@/components/agenda/ProjectedEntries'
import {
  bucketTasks,
  byDateThenPriority,
  TASK_BUCKETS,
  type TaskBucket,
} from '@/components/agenda/task-buckets'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionCount } from '@/components/ui/section-count'
import { SectionGroupHeader } from '@/components/ui/section-group-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useDuePanelData } from '@/hooks/useDuePanelData'
import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'
import { useWeekStart } from '@/hooks/useWeekStart'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { formatDate } from '@/lib/date-utils'

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

type Tab = 'all' | TaskBucket

const BUCKET_LABEL_KEYS: Record<Tab, string> = {
  all: 'duePanel.tabAll',
  overdue: 'duePanel.tabOverdue',
  today: 'duePanel.tabToday',
  thisWeek: 'duePanel.tabThisWeek',
  later: 'duePanel.tabLater',
  noDate: 'duePanel.tabNoDate',
}

const DAY_MS = 1000 * 60 * 60 * 24

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / DAY_MS,
  )
}

export function DuePanel({
  date,
  onNavigateToPage,
  excludePageId,
}: DuePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<Tab>('all')
  const { weekStartsOn } = useWeekStart()

  const {
    blocks,
    loading,
    hasMore,
    pageTitles,
    projectedEntries,
    projectedLoading,
    openTasks,
    openTasksLoading,
    isToday,
    loadMore,
  } = useDuePanelData({ date, excludePageId })

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const { handleBlockClick, getRowHandlers } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('block.untitled'),
  })

  const buckets = useMemo(() => {
    if (!isToday) return null
    const weekEnd = formatDate(endOfWeek(new Date(`${date}T00:00:00`), { weekStartsOn }))
    return bucketTasks(blocks, openTasks, date, weekEnd)
  }, [isToday, blocks, openTasks, date, weekStartsOn])

  const dayRows = useMemo(() => blocks.toSorted(byDateThenPriority(date)), [blocks, date])

  // A projected occurrence of a block already listed is the same task.
  const uniqueProjected = useMemo(() => {
    const listed = new Set([...blocks, ...openTasks].map((b) => b.id))
    return projectedEntries.filter((e) => !listed.has(e.block.id))
  }, [blocks, openTasks, projectedEntries])

  /** The visible list's sections, in order: one per non-empty bucket on All. */
  const sections = useMemo((): { bucket: TaskBucket | null; rows: BlockRow[] }[] => {
    if (buckets === null) return [{ bucket: null, rows: dayRows }]
    if (tab !== 'all') return [{ bucket: null, rows: buckets[tab] }]
    return TASK_BUCKETS.filter((b) => buckets[b].length > 0).map((b) => ({
      bucket: b,
      rows: buckets[b],
    }))
  }, [buckets, dayRows, tab])

  // The day's own rows and its projected occurrences list under Today.
  const showsToday = buckets === null || tab === 'all' || tab === 'today'
  const listedProjected = useMemo(
    () => (showsToday ? uniqueProjected : []),
    [showsToday, uniqueProjected],
  )

  const flatItems = useMemo(
    () => [...sections.flatMap((s) => s.rows), ...listedProjected.map((e) => e.block)],
    [sections, listedProjected],
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
    { homeEnd: true, pageUpDown: true, resetKey: `${tab}|${date}` },
  )

  const anyLoading = loading || projectedLoading || openTasksLoading
  const allItems = [...blocks, ...openTasks, ...uniqueProjected] as unknown[]
  if (!anyLoading && allItems.length === 0) return null

  // Today's projected occurrences count under Today, and so under All.
  const tabCount = (value: Tab): number => {
    if (buckets === null) return 0
    const counted: readonly TaskBucket[] = value === 'all' ? TASK_BUCKETS : [value]
    const projected = value === 'all' || value === 'today' ? uniqueProjected.length : 0
    return counted.reduce((sum, b) => sum + buckets[b].length, projected)
  }

  /** How long ago an overdue row's date was, on today's page only. */
  const ageNote = (block: BlockRow): string | undefined => {
    if (!isToday) return undefined
    if (block.due_date != null && block.due_date < date) {
      return `(${t('duePanel.daysOverdue', { count: daysBetween(block.due_date, date) })})`
    }
    if (block.scheduled_date != null && block.scheduled_date < date) {
      return `(${t('duePanel.scheduledDaysAgo', { count: daysBetween(block.scheduled_date, date) })})`
    }
    return undefined
  }

  let flatIndex = 0
  const renderRow = (block: BlockRow) => {
    const index = flatIndex++
    const rowHandlers = getRowHandlers(block)
    const note = ageNote(block)
    return (
      <BlockListItem
        key={block.id}
        blockId={block.id}
        content={block.content}
        contentMaxLength={120}
        emptyContentFallback={t('duePanel.emptyContent')}
        taskState={block.todo_state}
        priority={block.priority}
        priorityBadgeClassName="due-panel-priority"
        dueDate={block.due_date}
        scheduledDate={block.scheduled_date}
        {...(note !== undefined && { note })}
        pageId={block.page_id}
        pageTitle={block.page_id ? (pageTitles.get(block.page_id) ?? t('duePanel.untitled')) : ''}
        breadcrumbArrow={t('duePanel.breadcrumbArrow')}
        className="due-panel-item hover:bg-muted/50 active:bg-muted/70 ml-2 max-w-[calc(100%-0.5rem)]"
        contentClassName="due-panel-item-text"
        breadcrumbClassName="due-panel-breadcrumb"
        testId="due-panel-item"
        onClick={rowHandlers.onClick}
        onKeyDown={rowHandlers.onKeyDown}
        isFocused={focusedIndex === index}
      />
    )
  }

  const list = (
    // #1520 — roving tabindex: the focused row is the one tab stop, so the
    // container carries no `tabIndex`; keydown bubbles up from the row.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container (events bubble from the roving row); not itself focusable
    <div
      className="due-panel-content mt-1 space-y-2"
      ref={listRef}
      onKeyDown={(e) => {
        if (navHandleKeyDown(e)) e.preventDefault()
      }}
    >
      {flatItems.length === 0 && !anyLoading && (
        <EmptyState compact message={t('duePanel.emptyTab')} />
      )}
      {sections.map(
        ({ bucket, rows }) =>
          rows.length > 0 && (
            <div key={bucket ?? 'rows'}>
              {bucket !== null && (
                <SectionGroupHeader
                  asChild
                  className={bucket === 'overdue' ? 'text-alert-error-foreground' : undefined}
                >
                  <h2>{t(BUCKET_LABEL_KEYS[bucket])}</h2>
                </SectionGroupHeader>
              )}
              <ul className="due-panel-blocks m-0 list-none p-0">{rows.map(renderRow)}</ul>
            </div>
          ),
      )}
      <ProjectedEntriesSection
        entries={listedProjected}
        pageTitles={pageTitles}
        firstFlatIndex={flatItems.length - listedProjected.length}
        focusedIndex={focusedIndex}
        onNavigateToPage={onNavigateToPage}
      />
      <LoadMoreButton
        hasMore={hasMore && showsToday}
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

  return (
    <section className="due-panel" aria-label={t('duePanel.duePanelLabel')} data-testid="due-panel">
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={toggleCollapsed}
        className="due-panel-header"
        testId="due-panel-header"
      >
        {t('duePanel.heading')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <ListViewState
          loading={anyLoading && allItems.length === 0}
          items={allItems}
          skeleton={
            <div
              className="due-panel-loading flex items-center gap-2 px-2 py-2"
              aria-busy="true"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> takes phrasing content only, and this wraps <LoadingSkeleton>'s block rows
              role="status"
            >
              <LoadingSkeleton count={3} height="h-10" />
            </div>
          }
          empty={null}
        >
          {() =>
            buckets === null ? (
              list
            ) : (
              <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
                {/* Six tabs do not fit a phone's width: the row scrolls sideways. */}
                <ScrollArea orientation="horizontal" viewportClassName="pb-1">
                  <TabsList className="w-max min-w-full px-2" aria-label={t('duePanel.tabsLabel')}>
                    {(['all', ...TASK_BUCKETS] as const).map((value) => (
                      <TabsTrigger key={value} value={value} data-testid={`due-panel-tab-${value}`}>
                        <SectionCount label={t(BUCKET_LABEL_KEYS[value])} count={tabCount(value)} />
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </ScrollArea>
                <TabsContent value={tab}>{list}</TabsContent>
              </Tabs>
            )
          }
        </ListViewState>
      )}
    </section>
  )
}
