import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { DayEntry } from '../lib/date-utils'
import { countAgendaBatch, countBacklinksBatch } from '../lib/tauri'

export function useBatchCounts(entries: DayEntry[]) {
  const { t } = useTranslation()
  const [agendaCounts, setAgendaCounts] = useState<Record<string, number>>({})
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    const dates = entries.map((e) => e.dateStr)
    const pageIds = entries.filter((e) => e.pageId).map((e) => e.pageId as string)

    let cancelled = false
    async function fetchCounts() {
      const [agenda, backlinks] = await Promise.all([
        countAgendaBatch({ dates }),
        pageIds.length > 0
          ? countBacklinksBatch({ pageIds })
          : Promise.resolve({} as Record<string, number>),
      ])
      if (!cancelled) {
        setAgendaCounts(agenda)
        setBacklinkCounts(backlinks)
      }
    }
    fetchCounts().catch(() => toast.error(t('journal.loadCountsFailed')))
    return () => {
      cancelled = true
    }
  }, [entries, t])

  return { agendaCounts, backlinkCounts }
}
