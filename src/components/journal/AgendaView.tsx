/**
 * AgendaView — filtered task panels (AgendaResults, AgendaFilterBuilder).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { AgendaGroupBy, AgendaSortBy } from '../../lib/agenda-sort'
import { formatDate } from '../../lib/date-utils'
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
              // Map filter values to actual dates
              const today = new Date()
              const todayStr = formatDate(today)
              for (const value of filter.values) {
                if (value === 'Today') {
                  const resp = await listBlocks({
                    agendaDate: todayStr,
                    agendaSource: 'column:due_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This week') {
                  const day = today.getDay()
                  const mondayOffset = day === 0 ? -6 : 1 - day
                  const weekStart = new Date(today)
                  weekStart.setDate(today.getDate() + mondayOffset)
                  const weekEnd = new Date(weekStart)
                  weekEnd.setDate(weekStart.getDate() + 6)
                  const resp = await listBlocks({
                    agendaDateRange: { start: formatDate(weekStart), end: formatDate(weekEnd) },
                    agendaSource: 'column:due_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This month') {
                  const year = today.getFullYear()
                  const month = today.getMonth()
                  const monthStart = formatDate(new Date(year, month, 1))
                  const daysInMonth = new Date(year, month + 1, 0).getDate()
                  const monthEnd = formatDate(new Date(year, month, daysInMonth))
                  const resp = await listBlocks({
                    agendaDateRange: { start: monthStart, end: monthEnd },
                    agendaSource: 'column:due_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'Overdue') {
                  // Get all blocks with due_date < today
                  const resp = await queryByProperty({ key: 'due_date', limit: 500 })
                  for (const b of resp.items) {
                    if (b.due_date && b.due_date < todayStr && b.todo_state !== 'DONE') {
                      ids.add(b.id)
                      allBlocks.set(b.id, b)
                    }
                  }
                } else if (
                  value === 'Next 7 days' ||
                  value === 'Next 14 days' ||
                  value === 'Next 30 days'
                ) {
                  const numDays = value === 'Next 7 days' ? 7 : value === 'Next 14 days' ? 14 : 30
                  const rangeEnd = new Date(today)
                  rangeEnd.setDate(today.getDate() + numDays - 1)
                  const resp = await listBlocks({
                    agendaDateRange: { start: todayStr, end: formatDate(rangeEnd) },
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
                if (value === 'Today') {
                  const resp = await listBlocks({
                    agendaDate: todayStr,
                    agendaSource: 'column:scheduled_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This week') {
                  const day = today.getDay()
                  const mondayOffset = day === 0 ? -6 : 1 - day
                  const weekStart = new Date(today)
                  weekStart.setDate(today.getDate() + mondayOffset)
                  const weekEnd = new Date(weekStart)
                  weekEnd.setDate(weekStart.getDate() + 6)
                  const resp = await listBlocks({
                    agendaDateRange: { start: formatDate(weekStart), end: formatDate(weekEnd) },
                    agendaSource: 'column:scheduled_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This month') {
                  const year = today.getFullYear()
                  const month = today.getMonth()
                  const monthStart = formatDate(new Date(year, month, 1))
                  const daysInMonth = new Date(year, month + 1, 0).getDate()
                  const monthEnd = formatDate(new Date(year, month, daysInMonth))
                  const resp = await listBlocks({
                    agendaDateRange: { start: monthStart, end: monthEnd },
                    agendaSource: 'column:scheduled_date',
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'Overdue') {
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
                } else if (
                  value === 'Next 7 days' ||
                  value === 'Next 14 days' ||
                  value === 'Next 30 days'
                ) {
                  const numDays = value === 'Next 7 days' ? 7 : value === 'Next 14 days' ? 14 : 30
                  const rangeEnd = new Date(today)
                  rangeEnd.setDate(today.getDate() + numDays - 1)
                  const resp = await listBlocks({
                    agendaDateRange: { start: todayStr, end: formatDate(rangeEnd) },
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
              const todayStr = formatDate(today)
              for (const value of filter.values) {
                if (value === 'Today') {
                  const resp = await queryByProperty({
                    key: 'completed_at',
                    valueDate: todayStr,
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This week') {
                  const day = today.getDay()
                  const mondayOffset = day === 0 ? -6 : 1 - day
                  for (let d = 0; d < 7; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() + mondayOffset + d)
                    const dateStr = formatDate(date)
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
                } else if (value === 'This month') {
                  const year = today.getFullYear()
                  const month = today.getMonth()
                  const daysInMonth = new Date(year, month + 1, 0).getDate()
                  for (let d = 1; d <= daysInMonth; d++) {
                    const dateStr = formatDate(new Date(year, month, d))
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
                } else if (value === 'Last 7 days') {
                  for (let d = 0; d < 7; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() - d)
                    const dateStr = formatDate(date)
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
                } else if (value === 'Last 30 days') {
                  for (let d = 0; d < 30; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() - d)
                    const dateStr = formatDate(date)
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
              }
            } else if (filter.dimension === 'createdDate') {
              // created_at is a custom property — same pattern as completedDate
              const today = new Date()
              const todayStr = formatDate(today)
              for (const value of filter.values) {
                if (value === 'Today') {
                  const resp = await queryByProperty({
                    key: 'created_at',
                    valueDate: todayStr,
                    limit: 500,
                  })
                  for (const b of resp.items) {
                    ids.add(b.id)
                    allBlocks.set(b.id, b)
                  }
                } else if (value === 'This week') {
                  const day = today.getDay()
                  const mondayOffset = day === 0 ? -6 : 1 - day
                  for (let d = 0; d < 7; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() + mondayOffset + d)
                    const dateStr = formatDate(date)
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
                } else if (value === 'This month') {
                  const year = today.getFullYear()
                  const month = today.getMonth()
                  const daysInMonth = new Date(year, month + 1, 0).getDate()
                  for (let d = 1; d <= daysInMonth; d++) {
                    const dateStr = formatDate(new Date(year, month, d))
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
                } else if (value === 'Last 7 days') {
                  for (let d = 0; d < 7; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() - d)
                    const dateStr = formatDate(date)
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
                } else if (value === 'Last 30 days') {
                  for (let d = 0; d < 30; d++) {
                    const date = new Date(today)
                    date.setDate(today.getDate() - d)
                    const dateStr = formatDate(date)
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
