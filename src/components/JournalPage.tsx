/**
 * JournalPage — daily/weekly/monthly/agenda journal view backed by BlockTree.
 *
 * Four viewing modes:
 * - **Daily** (default): One day with prev/next navigation and today button.
 * - **Weekly**: Mon-Sun of one week, each day as a section with BlockTree.
 * - **Monthly**: Calendar grid showing content indicators; click to go to daily.
 * - **Agenda**: Task panels (TODO / DOING / DONE) with collapsible sections
 *   that load blocks matching the `todo` property on demand (paginated).
 *
 * A floating calendar date picker (react-day-picker in a positioned dropdown)
 * lets the user jump to any date. Days with content are highlighted.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCalendarPageDates } from '../hooks/useCalendarPageDates'
import { useJournalAutoCreate } from '../hooks/useJournalAutoCreate'
import { useJournalBlockCreation } from '../hooks/useJournalBlockCreation'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import type { NavigateToPageFn } from '../lib/block-events'
import type { DayEntry } from '../lib/date-utils'
import { formatDate, formatDateDisplay } from '../lib/date-utils'
import { useJournalStore } from '../stores/journal'
import { AgendaView } from './journal/AgendaView'
import { DailyView } from './journal/DailyView'
import { MonthlyView } from './journal/MonthlyView'
import { WeeklyView } from './journal/WeeklyView'
import { LinkPreviewTooltip } from './LinkPreviewTooltip'
import { LoadingSkeleton } from './LoadingSkeleton'

export type { DayEntry } from '../lib/date-utils'
// Re-export for backward compatibility
export { MAX_JOURNAL_DATE, MIN_JOURNAL_DATE } from '../lib/date-utils'
// MAINT-119 — Re-export sibling components so existing imports
// (`import { GlobalDateControls, JournalControls } from '../JournalPage'`)
// continue to work.
export { GlobalDateControls } from './GlobalDateControls'
export { JournalControls } from './JournalControls'

interface JournalPageProps {
  /** Called when a block is clicked -- navigates to block editor. */
  onBlockClick?: ((blockId: string) => void) | undefined
  /** Called to navigate to a page for editing. */
  onNavigateToPage?: NavigateToPageFn | undefined
}

// ── Component ─────────────────────────────────────────────────────────

export function JournalPage({
  onBlockClick: _onBlockClick,
  onNavigateToPage,
}: JournalPageProps): React.ReactElement {
  const { mode, currentDate, scrollToDate, scrollToPanel, clearScrollTarget } = useJournalStore(
    useShallow((s) => ({
      mode: s.mode,
      currentDate: s.currentDate,
      scrollToDate: s.scrollToDate,
      scrollToPanel: s.scrollToPanel,
      clearScrollTarget: s.clearScrollTarget,
    })),
  )
  const { pageMap, loading, addPage } = useCalendarPageDates()
  const { createdPages, handleAddBlock } = useJournalBlockCreation({
    pageMap,
    onPageCreated: addPage,
  })

  // Scroll to a specific day section when requested (e.g., Today button in weekly/monthly)
  useEffect(() => {
    if (!scrollToDate) return
    requestAnimationFrame(() => {
      const el = document.getElementById(`journal-${scrollToDate}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      clearScrollTarget()
    })
  }, [scrollToDate, clearScrollTarget])

  // Scroll to a specific panel (due/references/done) when requested from badges
  useEffect(() => {
    if (!scrollToPanel) return
    requestAnimationFrame(() => {
      const el = document.getElementById(`journal-${scrollToPanel}-panel`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      clearScrollTarget()
    })
  }, [scrollToPanel, clearScrollTarget])

  /** Build a DayEntry from a Date. */
  const makeDayEntry = useCallback(
    (d: Date): DayEntry => {
      const dateStr = formatDate(d)
      return {
        date: d,
        dateStr,
        displayDate: formatDateDisplay(d),
        pageId: createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null,
      }
    },
    [pageMap, createdPages],
  )

  // Auto-create the displayed day's page on mount / date change in daily mode
  // + keyboard shortcuts (Enter/n) to create a page when none exists
  useJournalAutoCreate({
    loading,
    mode,
    currentDate,
    pageMap,
    createdPages,
    handleAddBlock,
  })

  // ── Link preview tooltip — covers all blocks in the journal view ────
  const [journalContainerEl, setJournalContainerEl] = useState<HTMLDivElement | null>(null)
  // Stable DOM ref for usePrimaryFocus. Keeping this separate from the
  // callback-ref above (which powers LinkPreviewTooltip) avoids a rerender
  // loop from the registry re-running register() on every parent render.
  const journalDomRef = useRef<HTMLDivElement | null>(null)
  useRegisterPrimaryFocus(journalDomRef)
  const journalRef = useCallback((node: HTMLDivElement | null) => {
    setJournalContainerEl(node)
    journalDomRef.current = node
  }, [])

  // ── Main render ─────────────────────────────────────────────────────

  return (
    <div ref={journalRef} tabIndex={-1} className="space-y-4 focus:outline-none">
      {/* Loading indicator on initial fetch */}
      {loading && (
        <div aria-busy="true">
          <LoadingSkeleton count={3} height="h-10" data-testid="loading-skeleton" />
        </div>
      )}

      {/* View content */}
      {!loading && mode === 'daily' && (
        <DailyView
          entry={makeDayEntry(currentDate)}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'weekly' && (
        <WeeklyView
          makeDayEntry={makeDayEntry}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'monthly' && (
        <MonthlyView
          makeDayEntry={makeDayEntry}
          onNavigateToPage={onNavigateToPage}
          onAddBlock={handleAddBlock}
        />
      )}
      {!loading && mode === 'agenda' && <AgendaView onNavigateToPage={onNavigateToPage} />}

      {/* Link preview tooltip — covers all external links in journal */}
      <LinkPreviewTooltip container={journalContainerEl} />
    </div>
  )
}
