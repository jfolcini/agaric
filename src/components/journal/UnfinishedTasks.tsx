/**
 * UnfinishedTasks — collapsible section showing open tasks from before today.
 *
 * Queries blocks with todo_state in ('TODO', 'DOING') that have a due_date
 * or scheduled_date before today. Groups results by age: "Yesterday",
 * "This Week", "Older".
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CollapsiblePanelHeader } from '@/components/CollapsiblePanelHeader'

import { Badge } from '@/components/ui/badge'
import { StatusIcon } from '@/components/ui/status-icon'
import { formatCompactDate, getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../../hooks/useBlockNavigation'
import type { NavigateToPageFn } from '../../lib/block-events'
import { priorityColor } from '../../lib/priority-color'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve, queryByProperty } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { BlockListItem } from '../BlockListItem'
import { LoadingSkeleton } from '../LoadingSkeleton'

// ── Constants ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'unfinishedTasks.collapsed'
const GROUP_STORAGE_KEY = 'agaric:unfinishedTasks.groupCollapsed'

// ── Types ──────────────────────────────────────────────────────────────

interface AgeGroup {
  key: string
  i18nKey: string
  blocks: BlockRow[]
}

export interface UnfinishedTasksProps {
  onNavigateToPage?: NavigateToPageFn | undefined
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD in local time (avoids UTC issues from toISOString). */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Classify a date string into an age group relative to today. */
function classifyAge(dateStr: string, todayStr: string): 'yesterday' | 'thisWeek' | 'older' {
  const today = new Date(`${todayStr}T00:00:00`)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const yesterdayStr = toLocalDateStr(yesterday)

  if (dateStr === yesterdayStr) return 'yesterday'

  const weekAgo = new Date(today)
  weekAgo.setDate(today.getDate() - 7)
  const weekAgoStr = toLocalDateStr(weekAgo)

  // String comparison is valid because toLocalDateStr() guarantees YYYY-MM-DD format,
  // which is lexicographically sortable. All inputs to classifyAge() come from
  // toLocalDateStr() or the backend (which also uses YYYY-MM-DD).
  if (dateStr > weekAgoStr && dateStr < todayStr) return 'thisWeek'

  return 'older'
}

/** Group blocks by age: Yesterday, This Week, Older. */
function groupByAge(blocks: BlockRow[], todayStr: string): AgeGroup[] {
  const yesterday: BlockRow[] = []
  const thisWeek: BlockRow[] = []
  const older: BlockRow[] = []

  for (const block of blocks) {
    const dateStr = block.due_date ?? block.scheduled_date
    if (!dateStr) continue
    const age = classifyAge(dateStr, todayStr)
    if (age === 'yesterday') yesterday.push(block)
    else if (age === 'thisWeek') thisWeek.push(block)
    else older.push(block)
  }

  const groups: AgeGroup[] = []
  if (yesterday.length > 0)
    groups.push({ key: 'yesterday', i18nKey: 'unfinished.yesterday', blocks: yesterday })
  if (thisWeek.length > 0)
    groups.push({ key: 'thisWeek', i18nKey: 'unfinished.thisWeek', blocks: thisWeek })
  if (older.length > 0) groups.push({ key: 'older', i18nKey: 'unfinished.older', blocks: older })

  return groups
}

/** Read collapsed state from localStorage. Defaults to collapsed (true). */
function readCollapsedState(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) return true
    return stored === 'true'
  } catch {
    return true
  }
}

/** Persist collapsed state to localStorage. */
function writeCollapsedState(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
  } catch {
    // Silently ignore storage errors
  }
}

/**
 * Read per-group collapsed state from localStorage. SSR-safe; returns an
 * empty map if `localStorage` is unavailable or the stored JSON is corrupt.
 */
function readGroupCollapsedState(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const stored = window.localStorage.getItem(GROUP_STORAGE_KEY)
    if (stored === null) return {}
    const parsed = JSON.parse(stored) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/** Persist per-group collapsed state to localStorage. */
function writeGroupCollapsedState(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Silently ignore storage errors
  }
}

/** Merge two result pages and filter to unfinished tasks before today. */
function mergeAndFilterUnfinished(items: BlockRow[], todayStr: string): BlockRow[] {
  const seen = new Set<string>()
  const merged: BlockRow[] = []
  for (const b of items) {
    if (seen.has(b.id)) continue
    seen.add(b.id)

    // Filter: only TODO or DOING states
    if (b.todo_state !== 'TODO' && b.todo_state !== 'DOING') continue

    // Filter: due_date or scheduled_date must be before today
    const dateStr = b.due_date ?? b.scheduled_date
    if (!dateStr || dateStr >= todayStr) continue

    merged.push(b)
  }
  return merged
}

/** Resolve a set of page IDs to title map. Returns empty map on failure. */
async function resolvePageTitles(parentIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (parentIds.length === 0) return titles
  try {
    const resolved = await batchResolve(parentIds)
    for (const r of resolved) {
      titles.set(r.id, r.title ?? 'Untitled')
    }
  } catch {
    // Non-critical: breadcrumbs will show "Untitled"
  }
  return titles
}

// ── Component ──────────────────────────────────────────────────────────

export function UnfinishedTasks({
  onNavigateToPage,
}: UnfinishedTasksProps): React.ReactElement | null {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [collapsed, setCollapsed] = useState(readCollapsedState)
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [groupCollapsed, setGroupCollapsed] =
    useState<Record<string, boolean>>(readGroupCollapsedState)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const todayStr = useMemo(() => getTodayString(), [])

  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('unfinished.untitled'),
  })

  // Fetch unfinished tasks on mount
  useEffect(() => {
    let stale = false

    async function fetchUnfinished() {
      setLoading(true)
      try {
        // Query blocks with due_date and scheduled_date, then filter client-side
        const [dueResp, schedResp] = await Promise.all([
          queryByProperty({ key: 'due_date', limit: 500, spaceId: currentSpaceId }),
          queryByProperty({ key: 'scheduled_date', limit: 500, spaceId: currentSpaceId }),
        ])

        if (stale) return

        const merged = mergeAndFilterUnfinished([...dueResp.items, ...schedResp.items], todayStr)
        setBlocks(merged)

        // Resolve page titles for breadcrumbs (non-critical on failure)
        const parentIds = [...new Set(merged.map((b) => b.page_id).filter(Boolean))] as string[]
        if (parentIds.length > 0) {
          const titles = await resolvePageTitles(parentIds)
          if (!stale) {
            setPageTitles(titles)
          }
        }
      } catch {
        // On error, show empty state
        setBlocks([])
      } finally {
        if (!stale) setLoading(false)
      }
    }

    fetchUnfinished()
    return () => {
      stale = true
    }
  }, [todayStr, currentSpaceId])

  const groups = useMemo(() => groupByAge(blocks, todayStr), [blocks, todayStr])

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeCollapsedState(next)
      return next
    })
  }, [])

  const handleGroupToggle = useCallback((key: string) => {
    setGroupCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeGroupCollapsedState(next)
      return next
    })
  }, [])

  // Initial load: show a visible skeleton placeholder so sighted users see the
  // panel reserving space (rather than a blank gap that pops in when ready).
  if (loading) {
    return (
      <section
        aria-label={t('unfinished.loading')}
        aria-busy="true"
        role="status"
        data-testid="unfinished-tasks-loading"
      >
        <LoadingSkeleton count={3} height="h-10" className="unfinished-tasks-loading" />
      </section>
    )
  }

  // Don't render section if no unfinished tasks
  if (blocks.length === 0) return null

  return (
    <section aria-label={t('unfinished.sectionLabel')} data-testid="unfinished-tasks">
      <CollapsiblePanelHeader isCollapsed={collapsed} onToggle={handleToggle}>
        {t('unfinished.title')}
        <Badge variant="secondary" className="ml-2">
          {blocks.length}
        </Badge>
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="mt-1 space-y-3 animate-in fade-in-0 duration-150">
          {groups.map((group) => {
            const isGroupCollapsed = groupCollapsed[group.key] ?? false
            return (
              <div key={group.key} data-testid={`unfinished-group-${group.key}`}>
                <CollapsiblePanelHeader
                  isCollapsed={isGroupCollapsed}
                  onToggle={() => handleGroupToggle(group.key)}
                  className="py-1"
                >
                  <span className="text-xs uppercase tracking-wide">{t(group.i18nKey)}</span>
                  <Badge variant="outline" className="ml-1.5 text-xs">
                    {group.blocks.length}
                  </Badge>
                </CollapsiblePanelHeader>

                {!isGroupCollapsed && (
                  <ul className="space-y-1 mt-1" aria-label={t(group.i18nKey)}>
                    {group.blocks.map((block) => (
                      <BlockListItem
                        key={block.id}
                        blockId={block.id}
                        content={block.content}
                        metadata={
                          <>
                            <StatusIcon state={block.todo_state} showDone={false} />
                            {block.priority && (
                              <span
                                className={cn(
                                  'inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold',
                                  priorityColor(block.priority),
                                )}
                              >
                                P{block.priority}
                              </span>
                            )}
                            {(block.due_date ?? block.scheduled_date) && (
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                                  'bg-destructive/10 text-destructive',
                                )}
                              >
                                {formatCompactDate(
                                  (block.due_date ?? block.scheduled_date) as string,
                                )}
                              </span>
                            )}
                          </>
                        }
                        pageId={block.page_id}
                        pageTitle={pageTitles.get(block.page_id ?? '') ?? t('unfinished.untitled')}
                        breadcrumbArrow={t('unfinished.breadcrumbArrow')}
                        className="hover:bg-accent/50 active:bg-accent/70"
                        onClick={() => handleBlockClick(block)}
                        onKeyDown={(e) => handleBlockKeyDown(e, block)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
