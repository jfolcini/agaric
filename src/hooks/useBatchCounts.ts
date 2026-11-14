import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useGraphStructureEvents } from '@/hooks/useGraphStructureEvents'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { DayEntry } from '@/lib/date-utils'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

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
  // A `[[link]]` typed, pasted or synced changes the badge counts without any
  // property event; the graph-structure counter is what notices it.
  const { structureKey } = useGraphStructureEvents()
  // A date write staled `agenda_cache`; the backend sends the property event
  // again once the cache is rebuilt, which the read after the write may have
  // preceded (#6567).
  const { invalidationKey } = useBlockPropertyEvents()

  useEffect(() => {
    // #5415 — no active space: nothing to count, never dispatch.
    if (currentSpaceId == null) return
    const scope = requireActiveScope(currentSpaceId)
    let cancelled = false
    async function fetchCounts() {
      const [bySource, backlinks] = await Promise.all([
        commands.countAgendaBatchBySource(dates, scope).then(unwrap),
        // Thread the active space into
        // `count_backlinks_batch` so badge counts on cross-linked pages
        // exclude source blocks the user can't see.
        pageIds.length > 0
          ? commands.countBacklinksBatch(pageIds, scope).then(unwrap)
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `dates`/`pageIds` arrive as their serialized keys, so a new `entries` array with the same dates does not re-run the effect (#1632)
  }, [datesKey, pageIdsKey, t, currentSpaceId, structureKey, invalidationKey])

  return { agendaCounts, agendaCountsBySource, backlinkCounts }
}
