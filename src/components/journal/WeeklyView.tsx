/**
 * WeeklyView — 7-day grid rendering (Mon-Sun).
 */

import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { DayEntry } from '../../lib/date-utils'
import { formatDate, getWeekDays } from '../../lib/date-utils'
import { countAgendaBatch, countBacklinksBatch } from '../../lib/tauri'
import { useJournalStore } from '../../stores/journal'
import { DaySection } from './DaySection'

interface WeeklyViewProps {
  makeDayEntry: (d: Date) => DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
}

export function WeeklyView({
  makeDayEntry,
  onNavigateToPage,
  onAddBlock,
}: WeeklyViewProps): React.ReactElement {
  const { t } = useTranslation()
  const { currentDate } = useJournalStore()
  const todayStr = formatDate(new Date())
  const [agendaCounts, setAgendaCounts] = useState<Record<string, number>>({})
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({})

  const entries = useMemo(
    () => getWeekDays(currentDate).map(makeDayEntry),
    [currentDate, makeDayEntry],
  )

  // Fetch badge counts
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

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => {
        const isToday = entry.dateStr === todayStr
        return (
          <div key={entry.dateStr}>
            {i > 0 && <div className="border-t border-border my-4" />}
            <DaySection
              entry={entry}
              headingLevel={isToday ? 'h2' : 'h3'}
              compact
              mode="weekly"
              agendaCounts={agendaCounts}
              backlinkCounts={backlinkCounts}
              onNavigateToPage={onNavigateToPage}
              onAddBlock={onAddBlock}
            />
          </div>
        )
      })}
    </div>
  )
}
