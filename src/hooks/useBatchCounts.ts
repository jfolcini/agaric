import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { notify } from '@/lib/notify'

import type { DayEntry } from '../lib/date-utils'
import { logger } from '../lib/logger'
import { countAgendaBatchBySource, countBacklinksBatch } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

export function useBatchCounts(entries: DayEntry[]) {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [agendaCounts, setAgendaCounts] = useState<Record<string, number>>({})
  const [agendaCountsBySource, setAgendaCountsBySource] = useState<
    Record<string, Record<string, number>>
  >({})
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({})

  // PERF #1632 — the `entries` array reference churns whenever the parent's
  // `makeDayEntry` callback gets a new identity (e.g. on journal page
  // creation, which recreates the `createdPages` Map). Keying the fetch effect
  // directly on `entries` would then re-fire the batch-count IPC on unrelated
  // renders even though the actual inputs are unchanged. Derive the REAL
  // inputs (the date range + the set of page ids) and key the effect on their
  // serialized values so the IPC fires only when a date or a pageId actually
  // changes — which still correctly includes the case where page creation
  // surfaces a NEW pageId for backlink counting.
  const dates = useMemo(() => entries.map((e) => e.dateStr), [entries])
  const pageIds = useMemo(
    () => entries.filter((e) => e.pageId).map((e) => e.pageId as string),
    [entries],
  )
  const datesKey = dates.join(',')
  const pageIdsKey = pageIds.join(',')

  useEffect(() => {
    let cancelled = false
    async function fetchCounts() {
      const [bySource, backlinks] = await Promise.all([
        countAgendaBatchBySource({ dates, spaceId: currentSpaceId }),
        // PEND-35 Tier 1.6 — thread the active space into
        // `count_backlinks_batch` so badge counts on cross-linked pages
        // exclude source blocks the user can't see.
        pageIds.length > 0
          ? countBacklinksBatch({ pageIds, spaceId: currentSpaceId })
          : Promise.resolve({} as Record<string, number>),
      ])
      if (!cancelled) {
        setAgendaCountsBySource(bySource)
        // Compute total counts per date for backward compat
        const totals: Record<string, number> = {}
        for (const [date, sources] of Object.entries(bySource)) {
          totals[date] = Object.values(sources).reduce((sum, n) => sum + n, 0)
        }
        setAgendaCounts(totals)
        setBacklinkCounts(backlinks)
      }
    }
    fetchCounts().catch((err) => {
      logger.warn('useBatchCounts', 'batch counts fetch failed', undefined, err)
      notify.error(t('journal.loadCountsFailed'), { id: 'journal-load-counts-failed' })
    })
    return () => {
      cancelled = true
    }
    // `dates`/`pageIds` are intentionally consumed via their serialized keys so
    // the effect re-runs only when the date range or page-id set actually
    // changes, not when `entries` merely gets a new array identity (#1632).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [datesKey, pageIdsKey, t, currentSpaceId])

  return { agendaCounts, agendaCountsBySource, backlinkCounts }
}
