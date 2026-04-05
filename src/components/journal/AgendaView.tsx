/**
 * AgendaView — filtered task panels (AgendaResults, AgendaFilterBuilder).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { AgendaGroupBy, AgendaSortBy } from '../../lib/agenda-sort'
import { formatDate, getDateRangeForFilter } from '../../lib/date-utils'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve, listBlocks, queryByProperty } from '../../lib/tauri'
import type { AgendaFilter } from '../AgendaFilterBuilder'
import { AgendaFilterBuilder, AgendaSortGroupControls } from '../AgendaFilterBuilder'
import { AgendaResults } from '../AgendaResults'

interface AgendaViewProps {
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
}

export function AgendaView({ onNavigateToPage }: AgendaViewProps): React.ReactElement {
  // ── Agenda filter state ────────────────────────────────────────────
  const [agendaFilters, setAgendaFilters] = useState<AgendaFilter[]>([])
  const [filteredBlocks, setFilteredBlocks] = useState<BlockRow[]>([])
  const [agendaLoading, setAgendaLoading] = useState(false)
  const [agendaHasMore, setAgendaHasMore] = useState(false)
  const [agendaCursor, setAgendaCursor] = useState<string | null>(null)
  const [agendaPageTitles, setAgendaPageTitles] = useState<Map<string, string>>(new Map())

  // ── Agenda sort/group state (persisted in localStorage) ─────────────
  const [agendaGroupBy, setAgendaGroupBy] = useState<AgendaGroupBy>(() => {
    try {
      const stored = localStorage.getItem('agaric:agenda:groupBy')
      if (stored === 'date' || stored === 'priority' || stored === 'state' || stored === 'none')
        return stored
    } catch {
      /* ignore */
    }
    return 'date'
  })
  const [agendaSortBy, setAgendaSortBy] = useState<AgendaSortBy>(() => {
    try {
      const stored = localStorage.getItem('agaric:agenda:sortBy')
      if (stored === 'date' || stored === 'priority' || stored === 'state') return stored
    } catch {
      /* ignore */
    }
    return 'date'
  })

  useEffect(() => {
    try {
      localStorage.setItem('agaric:agenda:groupBy', agendaGroupBy)
    } catch {
      /* ignore */
    }
  }, [agendaGroupBy])

  useEffect(() => {
    try {
      localStorage.setItem('agaric:agenda:sortBy', agendaSortBy)
    } catch {
      /* ignore */
    }
  }, [agendaSortBy])

  // ── Agenda filter execution ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setAgendaLoading(true)

    async function executeFilters() {
      try {
        let blocks: BlockRow[] = []

        if (agendaFilters.length === 0) {
          // Default: blocks with due_date or scheduled_date (dated tasks only)
          const [dueResp, schedResp] = await Promise.all([
            queryByProperty({ key: 'due_date', limit: 500 }),
            queryByProperty({ key: 'scheduled_date', limit: 500 }),
          ])
          // Merge and deduplicate by id
          const seen = new Set<string>()
          const merged: BlockRow[] = []
          for (const b of [...dueResp.items, ...schedResp.items]) {
            if (!seen.has(b.id)) {
              seen.add(b.id)
              merged.push(b)
            }
          }
          blocks = merged
          setAgendaHasMore(false) // merged set doesn't support cursor pagination
          setAgendaCursor(null)
        } else {
          // Execute each filter dimension and intersect
          const resultSets: Set<string>[] = []
          const allBlocks = new Map<string, BlockRow>()

          for (const filter of agendaFilters) {
            const ids = new Set<string>()

            if (filter.dimension === 'status') {
              for (const value of filter.values) {
                const resp = await queryByProperty({
                  key: 'todo_state',
                  valueText: value,
                  limit: 500,
                })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            } else if (filter.dimension === 'priority') {
              for (const value of filter.values) {
                const resp = await queryByProperty({
                  key: 'priority',
                  valueText: value,
                  limit: 500,
                })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            } else if (filter.dimension === 'dueDate') {
              const today = new Date()
              const todayStr = formatDate(today)
              for (const value of filter.values) {
                if (value === 'Overdue') {
                  const resp = await queryByProperty({ key: 'due_date', limit: 500 })
                  for (const b of resp.items) {
                    if (b.due_date && b.due_date < todayStr && b.todo_state !== 'DONE') {
                      ids.add(b.id)
                      allBlocks.set(b.id, b)
                    }
                  }
                } else {
                  const preset =
                    value === 'Today'
                      ? 'today'
                      : value === 'This week'
                        ? 'this-week'
                        : value === 'This month'
                          ? 'this-month'
                          : value === 'Next 7 days'
                            ? 'next-7-days'
                            : value === 'Next 14 days'
                              ? 'next-14-days'
                              : value === 'Next 30 days'
                                ? 'next-30-days'
                                : null
                  if (!preset) continue
                  const range = getDateRangeForFilter(preset, today)
                  if (!range) continue
                  const resp =
                    range.start === range.end
                      ? await listBlocks({
                          agendaDate: range.start,
                          agendaSource: 'column:due_date',
                          limit: 500,
                        })
                      : await listBlocks({
                          agendaDateRange: range,
                          agendaSource: 'column:due_date',
                          limit: 500,
                        })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                }
              }
            } else if (filter.dimension === 'scheduledDate') {
              const today = new Date()
              const todayStr = formatDate(today)
              for (const value of filter.values) {
                if (value === 'Overdue') {
                  const resp = await queryByProperty({ key: 'scheduled_date', limit: 500 })
                  for (const b of resp.items) {
                    if (
                      b.scheduled_date &&
                      b.scheduled_date < todayStr &&
                      b.todo_state !== 'DONE'
                    ) {
                      ids.add(b.id)
                      allBlocks.set(b.id, b)
                    }
                  }
                } else {
                  const preset =
                    value === 'Today'
                      ? 'today'
                      : value === 'This week'
                        ? 'this-week'
                        : value === 'This month'
                          ? 'this-month'
                          : value === 'Next 7 days'
                            ? 'next-7-days'
                            : value === 'Next 14 days'
                              ? 'next-14-days'
                              : value === 'Next 30 days'
                                ? 'next-30-days'
                                : null
                  if (!preset) continue
                  const range = getDateRangeForFilter(preset, today)
                  if (!range) continue
                  const resp =
                    range.start === range.end
                      ? await listBlocks({
                          agendaDate: range.start,
                          agendaSource: 'column:scheduled_date',
                          limit: 500,
                        })
                      : await listBlocks({
                          agendaDateRange: range,
                          agendaSource: 'column:scheduled_date',
                          limit: 500,
                        })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                }
              }
            } else if (filter.dimension === 'completedDate') {
              // completed_at is a custom property — use queryByProperty with valueDate per day
              const today = new Date()
              for (const value of filter.values) {
                const preset =
                  value === 'Today'
                    ? 'today'
                    : value === 'This week'
                      ? 'this-week'
                      : value === 'This month'
                        ? 'this-month'
                        : value === 'Last 7 days'
                          ? 'last-7-days'
                          : value === 'Last 30 days'
                            ? 'last-30-days'
                            : null
                if (!preset) continue
                const range = getDateRangeForFilter(preset, today)
                if (!range) continue
                const start = new Date(`${range.start}T00:00:00`)
                const end = new Date(`${range.end}T00:00:00`)
                for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                  const dateStr = formatDate(d)
                  const resp = await queryByProperty({
                    key: 'completed_at',
                    valueDate: dateStr,
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                }
              }
            } else if (filter.dimension === 'createdDate') {
              // created_at is a custom property — same pattern as completedDate
              const today = new Date()
              for (const value of filter.values) {
                const preset =
                  value === 'Today'
                    ? 'today'
                    : value === 'This week'
                      ? 'this-week'
                      : value === 'This month'
                        ? 'this-month'
                        : value === 'Last 7 days'
                          ? 'last-7-days'
                          : value === 'Last 30 days'
                            ? 'last-30-days'
                            : null
                if (!preset) continue
                const range = getDateRangeForFilter(preset, today)
                if (!range) continue
                const start = new Date(`${range.start}T00:00:00`)
                const end = new Date(`${range.end}T00:00:00`)
                for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                  const dateStr = formatDate(d)
                  const resp = await queryByProperty({
                    key: 'created_at',
                    valueDate: dateStr,
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                }
              }
            } else if (filter.dimension === 'tag') {
              for (const value of filter.values) {
                const resp = await listBlocks({ tagId: value, limit: 500 })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            } else if (filter.dimension === 'property') {
              for (const filterValue of filter.values) {
                const colonIdx = filterValue.indexOf(':')
                const key = colonIdx > 0 ? filterValue.slice(0, colonIdx) : filterValue
                const value = colonIdx > 0 ? filterValue.slice(colonIdx + 1) : undefined
                const resp = await queryByProperty({
                  key,
                  ...(value != null && { valueText: value }),
                  limit: 500,
                })
                for (const b of resp.items) {
                  ids.add(b.id)
                  allBlocks.set(b.id, b)
                }
              }
            }

            resultSets.push(ids)
          }

          // Intersect all result sets
          if (resultSets.length > 0) {
            let intersection = resultSets[0] as Set<string>
            for (let i = 1; i < resultSets.length; i++) {
              intersection = new Set([...intersection].filter((id) => resultSets[i]?.has(id)))
            }
            blocks = [...intersection].map((id) => allBlocks.get(id) as BlockRow).filter(Boolean)
          }

          setAgendaHasMore(false) // Client-side intersection doesn't support pagination
          setAgendaCursor(null)
        }

        if (!cancelled) {
          setFilteredBlocks(blocks.slice(0, 200))
          setAgendaLoading(false)

          // Resolve page titles for breadcrumbs
          const parentIds = [...new Set(blocks.map((b) => b.parent_id).filter(Boolean))] as string[]
          if (parentIds.length > 0) {
            const resolved = await batchResolve(parentIds)
            const titleMap = new Map<string, string>()
            for (const r of resolved) {
              titleMap.set(r.id, r.title ?? 'Untitled')
            }
            if (!cancelled) setAgendaPageTitles(titleMap)
          }
        }
      } catch {
        if (!cancelled) {
          setFilteredBlocks([])
          setAgendaLoading(false)
        }
      }
    }

    executeFilters()
    return () => {
      cancelled = true
    }
  }, [agendaFilters])

  /** Load the next page of agenda results (used for default unfiltered view). */
  const loadMoreAgenda = useCallback(async () => {
    if (!agendaCursor) return
    setAgendaLoading(true)
    try {
      const resp = await queryByProperty({ key: 'todo_state', cursor: agendaCursor, limit: 200 })
      setFilteredBlocks((prev) => [...prev, ...resp.items])
      setAgendaHasMore(resp.has_more)
      setAgendaCursor(resp.next_cursor)
    } catch {
      // ignore
    }
    setAgendaLoading(false)
  }, [agendaCursor])

  return (
    <div className="agenda-view space-y-4" data-testid="agenda-view">
      <AgendaFilterBuilder filters={agendaFilters} onFiltersChange={setAgendaFilters} />
      <AgendaSortGroupControls
        groupBy={agendaGroupBy}
        onGroupByChange={setAgendaGroupBy}
        sortBy={agendaSortBy}
        onSortByChange={setAgendaSortBy}
      />
      <div className="border-t border-border/40" />
      <AgendaResults
        blocks={filteredBlocks}
        loading={agendaLoading}
        hasMore={agendaHasMore}
        onLoadMore={loadMoreAgenda}
        onNavigateToPage={onNavigateToPage}
        hasActiveFilters={agendaFilters.length > 0}
        onClearFilters={() => setAgendaFilters([])}
        pageTitles={agendaPageTitles}
        groupBy={agendaGroupBy}
        sortBy={agendaSortBy}
      />
    </div>
  )
}
