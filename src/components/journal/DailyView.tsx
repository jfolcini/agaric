/**
 * DailyView — single day rendering with due/scheduled/done panels.
 */

import type React from 'react'
import { useEffect, useMemo } from 'react'
import type { DayEntry } from '../../lib/date-utils'
import { getTodayString } from '../../lib/date-utils'
import { useBlockStore } from '../../stores/blocks'
import { useNavigationStore } from '../../stores/navigation'
import { DaySection } from './DaySection'
import { UnfinishedTasks } from './UnfinishedTasks'

interface DailyViewProps {
  entry: DayEntry
  onNavigateToPage?: ((pageId: string, title?: string) => void) | undefined
  onAddBlock: (dateStr: string) => void
}

export function DailyView({
  entry,
  onNavigateToPage,
  onAddBlock,
}: DailyViewProps): React.ReactElement {
  const isToday = useMemo(() => entry.dateStr === getTodayString(), [entry.dateStr])

  // UX-258: when navigating into a date-titled page with a target
  // selectedBlockId (search result, breadcrumb, graph node click, …),
  // scroll that block into view + restore focus on first paint, then
  // clear the navigation store one-shot. Mirrors `scrollFocusedBlockIntoView`
  // from useBlockKeyboardHandlers (UX-241): rAF + scrollIntoView({ block: 'nearest' }).
  const selectedBlockId = useNavigationStore((s) => s.selectedBlockId)
  const clearSelection = useNavigationStore((s) => s.clearSelection)

  useEffect(() => {
    if (!selectedBlockId) return
    const blockId = selectedBlockId
    const rafId = requestAnimationFrame(() => {
      document.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ block: 'nearest' })
      useBlockStore.getState().setFocused(blockId)
      // Clear the navigation marker after the work is done. Doing this inside
      // the rAF (rather than synchronously after scheduling it) means the
      // cleanup-side `cancelAnimationFrame` only fires on a true unmount —
      // not on the re-run triggered by the very state change we just made.
      clearSelection()
    })
    return () => cancelAnimationFrame(rafId)
  }, [selectedBlockId, clearSelection])

  return (
    <div key={entry.dateStr} className="space-y-4 animate-in fade-in-0 duration-150">
      {isToday && <UnfinishedTasks onNavigateToPage={onNavigateToPage} />}
      <DaySection
        entry={entry}
        headingLevel="h2"
        hideHeading
        mode="daily"
        onNavigateToPage={onNavigateToPage}
        onAddBlock={onAddBlock}
      />
    </div>
  )
}
