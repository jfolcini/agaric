/**
 * AgendaView — filtered task panels (AgendaResults, AgendaFilterBuilder).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useAgendaPreferences } from '../../hooks/useAgendaPreferences'
import { executeAgendaFilters } from '../../lib/agenda-filters'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve, queryByProperty } from '../../lib/tauri'
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
  const {
    groupBy: agendaGroupBy,
    sortBy: agendaSortBy,
    setGroupBy: setAgendaGroupBy,
    setSortBy: setAgendaSortBy,
  } = useAgendaPreferences()

  // ── Agenda filter execution ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setAgendaLoading(true)

    async function runFilters() {
      try {
        const result = await executeAgendaFilters(agendaFilters)

        if (!cancelled) {
          setFilteredBlocks(result.blocks.slice(0, 200))
          setAgendaHasMore(result.hasMore)
          setAgendaCursor(result.cursor)
          setAgendaLoading(false)

          // Resolve page titles for breadcrumbs
          const parentIds = [
            ...new Set(result.blocks.map((b) => b.parent_id).filter(Boolean)),
          ] as string[]
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

    runFilters()
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
      <div className="sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 space-y-4">
        <AgendaFilterBuilder filters={agendaFilters} onFiltersChange={setAgendaFilters} />
        <AgendaSortGroupControls
          groupBy={agendaGroupBy}
          onGroupByChange={setAgendaGroupBy}
          sortBy={agendaSortBy}
          onSortByChange={setAgendaSortBy}
        />
      </div>
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
