/**
 * BlockHistoryItem --- per-block history row with restore-with-preview panel.
 *
 * PEND-17 Part B: restore-with-preview redesign.
 *
 * Collapsed: timestamp + relative-age click target on the whole row.
 * Expanded (only `edit_block` ops with extractable content qualify):
 *
 *   1. Top    — primary `Restore this version (timestamp)` button.
 *               Click triggers `onRestore(entry)` directly. No
 *               ConfirmDialog: HistoryPanel snapshots + offers
 *               Undo on the success toast (`UX-275 sub-fix 4`).
 *   2. Middle — read-only `RichContentRenderer` showing the historical
 *               content as it would appear if restored.
 *   3. Bottom — segmented `ToggleGroup` switching between:
 *                 • `justThisChange`   — single-step diff (op vs. immediately
 *                                        previous version), reuses
 *                                        `useHistoryDiffToggle`'s cache.
 *                 • `comparedToCurrent` — `compute_block_vs_current_diff`
 *                                        IPC fetched lazily on first expand;
 *                                        DEFAULT mode (the panel exists to
 *                                        support the restore decision).
 *
 * Extracted from the monolithic `HistoryListItem.tsx` per the Phase 3b
 * design-system-maintainability plan (`pending/design-system-maintainability-2026-05-09.md`).
 * The orchestrator (`HistoryListItem.tsx`) keeps re-exporting
 * `BlockHistoryItem`, `BlockHistoryItemProps` and `BlockHistoryDiffMode`
 * so external consumers see no surface change.
 */

import { Lock, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { DiffDisplay } from '@/components/rendering/DiffDisplay'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

import { useRichContentCallbacks, useTagClickHandler } from '../../hooks/useRichContentCallbacks'
import { formatRelativeTime } from '../../lib/format-relative-time'
import { getPayloadRawContent } from '../../lib/history-utils'
import { logger } from '../../lib/logger'
import type { DiffSpan, HistoryEntry } from '../../lib/tauri'
import { computeBlockVsCurrentDiff } from '../../lib/tauri'
import { renderRichContent } from '../RichContentRenderer'
import { HistoryItemCore } from './HistoryItemCore'

const DIFF_MODE_DEFAULT: BlockHistoryDiffMode = 'comparedToCurrent'

export type BlockHistoryDiffMode = 'justThisChange' | 'comparedToCurrent'

export interface BlockHistoryItemProps {
  /** Block whose history is being shown. Required for `compute_block_vs_current_diff`. */
  blockId: string
  entry: HistoryEntry
  index: number
  /** Whether the row is expanded. Owned by the parent so keyboard nav can drive it. */
  isExpanded: boolean
  /** Loading state for the t('history.diffMode.justThisChange') diff (single-step). */
  isLoadingDiff: boolean
  /** t('history.diffMode.justThisChange') diff spans (op vs. immediately previous version). */
  diffSpans: DiffSpan[] | undefined
  /** Click on the whole row toggles expansion (only on restorable rows). */
  onExpandToggle: (entry: HistoryEntry, opening: boolean) => void
  /** Direct restore action — toast-with-Undo is the safety net (no ConfirmDialog). */
  onRestore: (entry: HistoryEntry) => void
  /**
   * MAINT-219: parent-owned ref attached to the expanded row's `Restore`
   * button so `HistoryPanel` can move DOM focus to it whenever
   * `expandedSeq` changes via keyboard navigation. Only attached when
   * `isExpanded` is true — collapsed rows never own this ref. The "focus
   * follows state" invariant keeps `↓`/`↑`/`Enter` deterministic: the
   * focused element is always the actionable row, so the row-level
   * `handleRowKeyDown` and panel-level `handlePanelKeyDown` no longer
   * disagree about which row `Enter` should restore.
   */
  restoreButtonRef?: React.RefObject<HTMLButtonElement | null>
}

export function BlockHistoryItem({
  blockId,
  entry,
  index,
  isExpanded,
  isLoadingDiff,
  diffSpans,
  onExpandToggle,
  onRestore,
  restoreButtonRef,
}: BlockHistoryItemProps): React.ReactElement {
  const { t } = useTranslation()
  const rawContent = getPayloadRawContent(entry)
  const isRestorable = entry.op_type === 'edit_block' && rawContent != null
  const richCallbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  // Diff mode is local to this row — switching mode never re-collapses
  // the panel and its default (`comparedToCurrent`) was selected
  // because the panel exists to support the restore decision.
  const [diffMode, setDiffMode] = React.useState<BlockHistoryDiffMode>(DIFF_MODE_DEFAULT)
  const [comparedDiff, setComparedDiff] = React.useState<DiffSpan[] | null>(null)
  const [comparedLoading, setComparedLoading] = React.useState(false)
  const [comparedFailed, setComparedFailed] = React.useState(false)

  // Lazy-fetch the compared-to-current diff on first expand. Refetch
  // when the entry's seq changes (e.g. parent renders a different row
  // into this slot under the same React key — defensive, not expected).
  //
  // The early-return guards (comparedDiff / comparedLoading /
  // comparedFailed) are intentionally NOT in the dep array — they are
  // SET by this effect, and including them creates a self-cancelling
  // loop: `setComparedLoading(true)` schedules a re-render, the effect
  // re-runs because comparedLoading changed, the previous run's
  // cleanup fires (`cancelled = true`) before the in-flight fetch
  // resolves, and the `.finally` skips `setComparedLoading(false)` —
  // leaving the spinner stuck forever in production (sync mocks in
  // tests resolve before the cleanup runs and miss this). Closures
  // capture each guard's value at the moment the effect runs, which
  // is the correct semantic for "skip this fetch if we already have
  // / are loading / failed for this expansion". The cleanup also
  // resets `comparedLoading` so a collapse mid-fetch doesn't leave
  // the spinner stuck on subsequent re-expand.
  /* oxlint-disable react-hooks/exhaustive-deps -- comparedDiff/comparedLoading/comparedFailed are runtime guards, not re-run triggers — see comment above. */
  React.useEffect(() => {
    if (!isExpanded || !isRestorable) return
    if (comparedDiff != null || comparedLoading || comparedFailed) return
    let cancelled = false
    setComparedLoading(true)
    computeBlockVsCurrentDiff({
      blockId,
      historicalCreatedAt: entry.created_at,
      historicalSeq: entry.seq,
    })
      .then((spans) => {
        if (cancelled) return
        setComparedDiff(spans)
      })
      .catch((err) => {
        if (cancelled) return
        // Mirrors the `useHistoryDiffToggle` toast policy so the two diff
        // modes behave consistently when a load fails — a single failure
        // doesn't keep retrying every render.
        logger.warn(
          'BlockHistoryItem',
          'computeBlockVsCurrentDiff failed',
          { blockId, seq: entry.seq },
          err,
        )
        notify.error(t('history.loadDiffFailed'))
        setComparedFailed(true)
      })
      .finally(() => {
        if (!cancelled) setComparedLoading(false)
      })
    return () => {
      cancelled = true
      // Defensive: if the user collapses mid-fetch, the resolved
      // promise's `.finally` will skip `setComparedLoading(false)`
      // because `cancelled === true`. Reset the spinner here so
      // subsequent re-expansions aren't blocked by a stuck loading
      // flag.
      setComparedLoading(false)
    }
  }, [isExpanded, isRestorable, blockId, entry.seq, t])
  /* oxlint-enable react-hooks/exhaustive-deps */

  const handleRowClick = (e: React.MouseEvent) => {
    if (!isRestorable) return
    // Don't double-toggle when the click originated inside the expanded
    // panel (Restore button, ToggleGroup, RichContentRenderer link).
    if ((e.target as HTMLElement).closest('[data-history-panel-content]')) return
    onExpandToggle(entry, !isExpanded)
  }

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (!isRestorable) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onExpandToggle(entry, !isExpanded)
    }
  }

  const activeSpans =
    diffMode === 'comparedToCurrent'
      ? (comparedDiff?.map((s) => {
          if (s.tag === 'Insert') return { ...s, tag: 'Delete' as const }
          if (s.tag === 'Delete') return { ...s, tag: 'Insert' as const }
          return s
        }) ?? undefined)
      : diffSpans
  const activeLoading = diffMode === 'comparedToCurrent' ? comparedLoading : isLoadingDiff

  return (
    <li
      data-testid={`block-history-item-${index}`}
      data-block-history-item
      data-seq={entry.seq}
      className={cn(
        'flex flex-col gap-1.5 px-2 py-2 border-b border-border/20',
        isRestorable && 'hover:bg-accent/20',
        isExpanded && 'bg-accent/30',
      )}
    >
      {/* Collapsed-state click target — the whole row. We use a div with
          conditional role="button" rather than a real <button> because the
          row already contains nested interactive elements (Tooltip-wrapped
          timestamp, Badge with potential popover). Non-restorable rows
          render no role at all (just a static div). */}
      {isRestorable ? (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- row contains nested interactive elements (Tooltip timestamp, Badge popover) via HistoryItemCore; a real <button> can't legally nest interactive content
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? `block-history-panel-${index}` : undefined}
          data-testid={`block-history-row-${index}`}
          className="flex items-center gap-2 w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          onClick={handleRowClick}
          onKeyDown={handleRowKeyDown}
        >
          <HistoryItemCore entry={entry} />
        </div>
      ) : (
        // Non-restorable rows stack `flex-col` so the lock chip drops onto
        // its own line below the metadata stripe instead of competing for
        // horizontal width with the timestamp / device id. Every
        // `create_block` row is non-restorable, so this was the single
        // largest contributor to "crowded row" in the narrow Sheet.
        // Restorable rows (the branch above) stay `flex items-center` —
        // they don't render the lock chip, so their layout is fine.
        <div
          data-testid={`block-history-row-${index}`}
          className="flex flex-col items-start gap-1 w-full"
        >
          <HistoryItemCore entry={entry} />
          {/* MAINT-220: re-add the lock affordance + tooltip for
              non-restorable rows so users understand why the row is
              inert. Mirrors the legacy `HistoryListItem` rendering at
              lines ~330-344 (UX-351's "two visual cues for WCAG"
              rationale: opacity-50 alone was a single cue; the lock
              icon + visible label adds a second cue for both visual
              and SR users). i18n keys `history.nonReversibleLabel` /
              `history.nonReversibleTooltip` are reused from the
              legacy path — no new translations needed. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('history.nonReversibleLabel')}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('history.nonReversibleTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
      {isExpanded && isRestorable && rawContent != null && (
        <div
          id={`block-history-panel-${index}`}
          data-history-panel-content
          data-testid={`block-history-panel-${index}`}
          className="block-history-panel mt-1 flex flex-col gap-3 rounded-md border border-border/40 bg-background p-3"
        >
          <Button
            type="button"
            variant="default"
            size="sm"
            data-testid={`block-history-restore-${index}`}
            className="self-start"
            onClick={() => onRestore(entry)}
            // MAINT-219: only the currently-expanded row attaches this
            // ref (the prop itself is only forwarded by the parent for
            // the expanded slot). Skipping the conditional check would
            // be safe but redundant.
            ref={restoreButtonRef}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {t('history.restoreThisVersion', {
              timestamp: formatRelativeTime(entry.created_at, t),
            })}
          </Button>
          {/* The preview is a labelled region — using a real <section>
              gives the aria-label semantic meaning for AT users without
              the `role="region"` ⇒ `<section>` lint rewrite. */}
          <section
            data-testid={`block-history-preview-${index}`}
            aria-label={t('history.previewLabel')}
            className="block-history-preview rounded-md border border-border/30 bg-muted/30 p-2 text-sm"
          >
            {renderRichContent(rawContent, {
              interactive: false,
              onTagClick,
              ...richCallbacks,
            })}
          </section>
          <div className="flex items-center justify-between gap-2">
            <ToggleGroup
              type="single"
              value={diffMode}
              onValueChange={(v: string) => {
                // Radix emits '' when the user clicks the active item.
                // Ignore that — keep the current mode pinned (the diff
                // pane below would otherwise have nothing to render).
                if (v === 'justThisChange' || v === 'comparedToCurrent') {
                  setDiffMode(v)
                }
              }}
              aria-label={t('history.diffMode.label')}
              data-testid={`block-history-diff-mode-${index}`}
            >
              <ToggleGroupItem
                value="justThisChange"
                data-testid={`block-history-diff-mode-just-${index}`}
              >
                {t('history.diffMode.justThisChange')}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="comparedToCurrent"
                data-testid={`block-history-diff-mode-current-${index}`}
              >
                {t('history.diffMode.comparedToCurrent')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="diff-container w-full">
            {activeLoading ? (
              <Spinner className="h-4 w-4" />
            ) : activeSpans != null ? (
              <DiffDisplay spans={activeSpans} />
            ) : null}
          </div>
        </div>
      )}
    </li>
  )
}
