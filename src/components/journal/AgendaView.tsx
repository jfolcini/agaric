/**
 * AgendaView — filtered task panels (AgendaResults, AgendaFilterBuilder).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { useAgendaPreferences } from '../../hooks/useAgendaPreferences'
import { executeAgendaFilters } from '../../lib/agenda-filters'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve, queryByProperty } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import type { AgendaFilter } from '../AgendaFilterBuilder'
import { AgendaFilterBuilder, AgendaSortGroupControls } from '../AgendaFilterBuilder'
import { AgendaResults } from '../AgendaResults'
import { ViewHeader } from '../ViewHeader'
import { buildPageTitleMap, processFilterResult } from './AgendaView.helpers'

interface AgendaViewProps {
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
}

export function AgendaView({ onNavigateToPage }: AgendaViewProps): React.ReactElement {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // ── Agenda filter state ────────────────────────────────────────────
  // Default to active task states (TODO + DOING) so the agenda opens with
  // actionable items only — DONE is hidden until the user clears the filter
  // or adds their own status filter (UX-196).
  const [agendaFilters, setAgendaFilters] = useState<AgendaFilter[]>([
    { dimension: 'status', values: ['TODO', 'DOING'] },
  ])
  const [filteredBlocks, setFilteredBlocks] = useState<BlockRow[]>([])
  const [agendaLoading, setAgendaLoading] = useState(false)
  const [agendaHasMore, setAgendaHasMore] = useState(false)
  const [agendaCursor, setAgendaCursor] = useState<string | null>(null)
  const [agendaPageTitles, setAgendaPageTitles] = useState<Map<string, string>>(new Map())
  // Counter to force re-fetch after inline date edits (F-22)
  const [refreshKey, setRefreshKey] = useState(0)

  // ── Agenda sort/group state (persisted in localStorage) ─────────────
  const {
    groupBy: agendaGroupBy,
    sortBy: agendaSortBy,
    setGroupBy: setAgendaGroupBy,
    setSortBy: setAgendaSortBy,
  } = useAgendaPreferences()

  // ── Agenda filter execution ────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey forces re-fetch after inline date edits
  useEffect(() => {
    let cancelled = false
    setAgendaLoading(true)

    async function runFilters() {
      try {
        const result = await executeAgendaFilters(agendaFilters, currentSpaceId)
        if (cancelled) return

        const outcome = processFilterResult(result)
        setFilteredBlocks(outcome.blocks)
        setAgendaHasMore(outcome.hasMore)
        setAgendaCursor(outcome.cursor)
        setAgendaLoading(false)

        // Resolve page titles for breadcrumbs
        if (outcome.pageIds.length === 0) return
        const resolved = await batchResolve(outcome.pageIds)
        if (cancelled) return
        setAgendaPageTitles(buildPageTitleMap(resolved))
      } catch (err) {
        logger.warn(
          'AgendaView',
          'Agenda filter query failed, showing empty results',
          undefined,
          err,
        )
        if (cancelled) return
        setFilteredBlocks([])
        setAgendaLoading(false)
      }
    }

    runFilters()
    return () => {
      cancelled = true
    }
  }, [agendaFilters, refreshKey, currentSpaceId])

  /** Load the next page of agenda results (used for default unfiltered view). */
  const loadMoreAgenda = useCallback(async () => {
    if (!agendaCursor) return
    setAgendaLoading(true)
    try {
      const resp = await queryByProperty({
        key: 'todo_state',
        cursor: agendaCursor,
        limit: 200,
        spaceId: currentSpaceId,
      })
      setFilteredBlocks((prev) => [...prev, ...resp.items])
      setAgendaHasMore(resp.has_more)
      setAgendaCursor(resp.next_cursor)
    } catch (err) {
      logger.warn('AgendaView', 'Failed to load more agenda items', undefined, err)
    }
    setAgendaLoading(false)
  }, [agendaCursor, currentSpaceId])

  return (
    <div className="agenda-view space-y-4" data-testid="agenda-view">
      <ViewHeader>
        <div className="agenda-view-header">
          <AgendaFilterBuilder filters={agendaFilters} onFiltersChange={setAgendaFilters} />
          <div className="border-t border-border/40 my-3" aria-hidden="true" />
          <AgendaSortGroupControls
            groupBy={agendaGroupBy}
            onGroupByChange={setAgendaGroupBy}
            sortBy={agendaSortBy}
            onSortByChange={setAgendaSortBy}
          />
        </div>
      </ViewHeader>
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
        onDateChanged={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
