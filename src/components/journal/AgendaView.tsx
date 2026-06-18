/**
 * AgendaView — filtered task panels (AgendaResults, AgendaFilterBuilder).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'

import type { AgendaFilter } from '@/components/agenda/AgendaFilterBuilder'
import {
  AgendaFilterBuilder,
  AgendaSortGroupControls,
} from '@/components/agenda/AgendaFilterBuilder'
import { AgendaResults } from '@/components/agenda/AgendaResults'
import { ViewHeader } from '@/components/layout/ViewHeader'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { useAgendaPreferences } from '../../hooks/useAgendaPreferences'
import {
  executeAgendaFilters,
  loadMoreAgendaFilters,
  loadMoreUnfilteredAgenda,
} from '../../lib/agenda-filters'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { appendUniqueBlocks, buildPageTitleMap, processFilterResult } from './AgendaView.helpers'

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
  // #1345 — the initial-query failure used to be swallowed (logged + empty
  // results), so a backend failure looked identical to a genuinely empty
  // agenda. Track the error so AgendaResults can render a distinct,
  // retryable error card instead of the benign "No tasks found" state.
  const [agendaError, setAgendaError] = useState(false)
  const [agendaHasMore, setAgendaHasMore] = useState(false)
  const [agendaCursor, setAgendaCursor] = useState<string | null>(null)
  // #720 — the `today` page 1's date-preset translation used. Threaded
  // back into loadMoreAgendaFilters so a page fetched after midnight
  // continues page 1's predicate instead of recomputing a new one.
  const [agendaToday, setAgendaToday] = useState<Date | undefined>(undefined)
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
  useEffect(() => {
    let cancelled = false
    setAgendaLoading(true)
    // Clear any prior failure at the start of a fresh run so a successful
    // retry drops the error card.
    setAgendaError(false)

    async function runFilters() {
      try {
        const result = await executeAgendaFilters(agendaFilters, currentSpaceId)
        if (cancelled) return

        const outcome = processFilterResult(result)
        setFilteredBlocks(outcome.blocks)
        setAgendaHasMore(outcome.hasMore)
        setAgendaCursor(outcome.cursor)
        setAgendaToday(result.today)
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
        setAgendaError(true)
        setAgendaLoading(false)
      }
    }

    runFilters()
    return () => {
      cancelled = true
    }
  }, [agendaFilters, refreshKey, currentSpaceId])

  /**
   * Load the next page of agenda results.
   *
   * Two cursor namespaces are in play here — they cannot be mixed:
   * - Active filters → page 1 came from `filteredBlocksQuery`; page 2
   *   must continue that AND-intersection by routing back through the
   *   same IPC with the same filter payload AND the same `today`
   *   reference date (#720). Done via `loadMoreAgendaFilters`.
   * - No filters → page 1 came from the merged due/scheduled/undated
   *   window in `executeAgendaFilters`; the cursor is the composite
   *   `agenda-unfiltered:` cursor consumed by `loadMoreUnfilteredAgenda`
   *   (#721).
   */
  const loadMoreAgenda = useCallback(async () => {
    if (!agendaCursor) return
    setAgendaLoading(true)
    try {
      const result =
        agendaFilters.length > 0
          ? await loadMoreAgendaFilters(agendaFilters, agendaCursor, currentSpaceId, agendaToday)
          : await loadMoreUnfilteredAgenda(agendaCursor, currentSpaceId)
      setFilteredBlocks((prev) => appendUniqueBlocks(prev, result.blocks))
      setAgendaHasMore(result.hasMore)
      setAgendaCursor(result.cursor)
    } catch (err) {
      logger.warn('AgendaView', 'Failed to load more agenda items', undefined, err)
      // #1345 — a load-more failure used to silently return the button to
      // idle with no feedback or retry path. Surface a retryable toast so
      // the user can re-attempt the same page fetch.
      notify.retry(t('agenda.loadMoreFailed'), loadMoreAgenda)
    }
    setAgendaLoading(false)
  }, [agendaCursor, agendaFilters, currentSpaceId, agendaToday])

  // #1345 — re-run the initial filter query after a failure. Reuses the
  // `refreshKey` bump (which also re-triggers the fetch effect) so the
  // error card's Retry action and inline date-edit refreshes share one
  // path.
  const retryFilters = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

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
        error={agendaError}
        onRetry={retryFilters}
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
