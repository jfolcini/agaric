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

import { Settings2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { Button } from '@/components/ui/button'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { useCalendarPageDates } from '../hooks/useCalendarPageDates'
import { useJournalAutoCreate } from '../hooks/useJournalAutoCreate'
import { useJournalBlockCreation } from '../hooks/useJournalBlockCreation'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { useScrollToFocus } from '../hooks/useScrollToFocus'
import type { NavigateToPageFn } from '../lib/block-events'
import type { DayEntry } from '../lib/date-utils'
import { formatDate, formatDateDisplay, getCalendarMonthRange } from '../lib/date-utils'
import { useJournalStore } from '../stores/journal'
import { useSpaceStore } from '../stores/space'
import { useInPageFindStore } from '../stores/useInPageFindStore'
import { AgendaView } from './journal/AgendaView'
import { DailyView } from './journal/DailyView'
import { MonthlyView } from './journal/MonthlyView'
import { WeeklyView } from './journal/WeeklyView'
import { LinkPreviewTooltip } from './LinkPreviewTooltip'
import { LoadingSkeleton } from './LoadingSkeleton'
import { SpaceManageDialog } from './SpaceManageDialog'

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
  const { t } = useTranslation()
  const { mode, currentDate, scrollToDate, scrollToPanel, clearScrollTarget } = useJournalStore(
    useShallow((s) => ({
      mode: s.mode,
      currentDate: s.currentDate,
      scrollToDate: s.scrollToDate,
      scrollToPanel: s.scrollToPanel,
      clearScrollTarget: s.clearScrollTarget,
    })),
  )
  const calendarRange = useMemo(() => getCalendarMonthRange(currentDate), [currentDate])
  const { pageMap, loading, addPage } = useCalendarPageDates(calendarRange)
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // UX-371 — surface the per-space journal-template configuration from the
  // Journal view itself; previously only reachable through Manage Spaces.
  // SpaceManageDialog has no scroll-to-section prop, so the dialog opens at
  // the top and the user navigates to the template field from there.
  const [manageOpen, setManageOpen] = useState(false)
  const { createdPages, handleAddBlock } = useJournalBlockCreation({
    pageMap,
    onPageCreated: addPage,
  })

  // Scroll to a specific day section when requested (e.g., Today button in weekly/monthly)
  useScrollToFocus(scrollToDate ? `journal-${scrollToDate}` : null, {
    behavior: 'smooth',
    block: 'start',
    onComplete: clearScrollTarget,
  })

  // Scroll to a specific panel (due/references/done) when requested from badges
  useScrollToFocus(scrollToPanel ? `journal-${scrollToPanel}-panel` : null, {
    behavior: 'smooth',
    block: 'start',
    onComplete: clearScrollTarget,
  })

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
    spaceId: currentSpaceId ?? '',
    createdPages,
    handleAddBlock,
  })

  // ── Link preview tooltip — covers all blocks in the journal view ────
  // PEND-52 — same container element also doubles as the in-page-find
  // host so the Ctrl+F toolbar can walk every block in the active mode
  // (daily section, weekly grid, monthly cells, agenda panels).
  const setFindContainer = useInPageFindStore((s) => s.setContainer)
  const [journalContainerEl, setJournalContainerEl] = useState<HTMLDivElement | null>(null)
  // Stable DOM ref for usePrimaryFocus. Keeping this separate from the
  // callback-ref above (which powers LinkPreviewTooltip) avoids a rerender
  // loop from the registry re-running register() on every parent render.
  const journalDomRef = useRef<HTMLDivElement | null>(null)
  useRegisterPrimaryFocus(journalDomRef)
  const journalRef = useCallback(
    (node: HTMLDivElement | null) => {
      setJournalContainerEl(node)
      journalDomRef.current = node
      setFindContainer(node)
    },
    [setFindContainer],
  )
  useEffect(() => {
    return () => {
      setFindContainer(null)
    }
  }, [setFindContainer])

  // ── Main render ─────────────────────────────────────────────────────

  // PEND-UX item 5 — the configure-journal-template action moves from a
  // free-floating right-aligned button row into the shared
  // `FeaturePageHeader` `actions` slot. The same agenda-mode visibility
  // guard is preserved (UX-371: templates don't apply in agenda mode).
  const showConfigureTemplateAction = !loading && mode !== 'agenda'

  return (
    <div ref={journalRef} tabIndex={-1} className="space-y-4 focus-ring-visible">
      {/* PEND-UX item 5 — `<h1>` landmark for the Journal view. The App-
          shell header renders `<JournalControls />` instead of a label
          for journal mode, so this title is purely additive (no visual
          duplication). The configure-template button is surfaced as a
          right-aligned action when available. */}
      <FeaturePageHeader
        title={t('sidebar.journal')}
        className="journal-page-header"
        {...(showConfigureTemplateAction && {
          actions: (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('space.configureJournalTemplate')}
                    onClick={() => setManageOpen(true)}
                    data-testid="journal-configure-template-trigger"
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('space.configureJournalTemplate')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ),
        })}
      />

      {/* Loading indicator on initial fetch */}
      {loading && (
        <LoadingSkeleton count={3} height="h-10" loading data-testid="loading-skeleton" />
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
      {!loading && mode === 'monthly' && <MonthlyView makeDayEntry={makeDayEntry} />}
      {!loading && mode === 'agenda' && <AgendaView onNavigateToPage={onNavigateToPage} />}

      {/* Link preview tooltip — covers all external links in journal */}
      <LinkPreviewTooltip container={journalContainerEl} />

      {/* UX-371 — manage-spaces dialog hosts the per-space `journal_template`
          textarea (see SpaceManageDialog L425-444). */}
      <SpaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  )
}
