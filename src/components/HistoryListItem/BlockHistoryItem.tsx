/**
 * BlockHistoryItem --- per-block history row with restore-with-preview panel.
 *
 * Part B: restore-with-preview redesign.
 *
 * Collapsed: timestamp + relative-age click target on the whole row.
 * Expanded (only `edit_block` ops with extractable content qualify):
 *
 *   1. Top    — primary `Restore this version (timestamp)` button.
 *               Click triggers `onRestore(entry)` directly. No
 *               ConfirmDialog: HistoryPanel snapshots + offers
 * Undo on the success toast (` sub-fix 4`).
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
 * Extracted from the once-monolithic `HistoryListItem.tsx` into a sibling
 * file. The orchestrator (`HistoryListItem.tsx`) keeps re-exporting
 * `BlockHistoryItem`, `BlockHistoryItemProps` and `BlockHistoryDiffMode`
 * so external consumers see no surface change.
 */

import { AlertTriangle, Lock, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { HistoryItemCore } from '@/components/HistoryListItem/HistoryItemCore'
import { DiffDisplay } from '@/components/rendering/DiffDisplay'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Button } from '@/components/ui/button'
import { InfoPopover } from '@/components/ui/info-popover'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { DiffSpan, HistoryEntry } from '@/lib/bindings'
import { formatTimestamp } from '@/lib/format'
import { getPayloadRawContent } from '@/lib/history-utils'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

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
   * Parent-owned ref attached to the expanded row's `Restore`
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
  // #1736: bumped by the retry affordance to force the lazy-fetch effect to
  // re-run after a failure. The guard state (comparedFailed/comparedDiff) is
  // intentionally NOT in the effect's dep array, so it can't drive a re-fetch
  // on its own — this nonce is a real dep that does.
  const [retryNonce, setRetryNonce] = React.useState(0)

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
  React.useEffect(() => {
    if (!isExpanded || !isRestorable) return
    if (comparedDiff != null || comparedLoading || comparedFailed) return
    let cancelled = false
    setComparedLoading(true)
    commands
      .computeBlockVsCurrentDiff(blockId, entry.created_at, entry.seq)
      .then((res) => {
        const spans = unwrap(res)
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the comparedDiff/comparedLoading/comparedFailed guards are set by this effect; listing them cancels its own fetch (see above)
  }, [isExpanded, isRestorable, blockId, entry.seq, t, retryNonce])

  // #1736: clear the failure guard (and any stale diff) and bump the nonce so
  // the lazy-fetch effect re-runs. comparedFailed/comparedDiff alone can't
  // re-trigger the effect (not deps); the nonce is the actual re-run trigger.
  const handleRetryComparedDiff = React.useCallback(() => {
    setComparedDiff(null)
    setComparedFailed(false)
    setRetryNonce((n) => n + 1)
  }, [])

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
          if (s.tag === 'Insert') return { tag: 'Delete' as const, value: s.value }
          if (s.tag === 'Delete') return { tag: 'Insert' as const, value: s.value }
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
      {/* Collapsed-state click target — the whole row, a div with
          role="button" because a <button> cannot hold the core's block
          content. Non-restorable rows render no role at all. */}
      {isRestorable ? (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- HistoryItemCore renders block content (rich-content preview) that a real <button> cannot hold
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? `block-history-panel-${index}` : undefined}
          data-testid={`block-history-row-${index}`}
          className="flex items-center gap-2 w-full cursor-pointer focus-ring-visible rounded-sm"
          onClick={handleRowClick}
          onKeyDown={handleRowKeyDown}
        >
          <HistoryItemCore entry={entry} inRowButton />
        </div>
      ) : (
        // Non-restorable rows stack `flex-col` so the lock chip drops onto
        // its own line below the metadata stripe instead of competing for
        // horizontal width with the timestamp / device name. Every
        // `create_block` row is non-restorable, so this was the single
        // largest contributor to "crowded row" in the narrow Sheet.
        // Restorable rows (the branch above) stay `flex items-center` —
        // they don't render the lock chip, so their layout is fine.
        // Enter or Space on the time or an ⓘ presses that control; it must not
        // reach the list, whose Enter restores the expanded row.
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- only stops keys bubbling from the controls inside
        <div
          data-testid={`block-history-row-${index}`}
          className="flex flex-col items-start gap-1 w-full"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
          }}
        >
          <HistoryItemCore entry={entry} />
          {/* Why the row is inert: the lock and visible label are two cues
              beyond the row's look, and the ⓘ says why. */}
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('history.nonReversibleLabel')}</span>
            <InfoPopover
              variant="icon"
              ariaLabel={t('history.nonReversibleInfoLabel')}
              content={t('history.nonReversibleTooltip')}
            />
          </span>
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
            // Only the currently-expanded row attaches this
            // ref (the prop itself is only forwarded by the parent for
            // the expanded slot). Skipping the conditional check would
            // be safe but redundant.
            ref={restoreButtonRef}
          >
            <RotateCcw className="mr-1.5" />
            {/* The exact time: the row above shows only the relative one, since
                that row is a button and cannot hold the RelativeTime toggle. */}
            {t('history.restoreThisVersion', {
              timestamp: formatTimestamp(entry.created_at, 'full'),
            })}
          </Button>
          {/* The preview is a labelled region — using a real <section>
              gives the aria-label semantic meaning for AT users without
              the `role="region"` ⇒ `<section>` lint rewrite. */}
          <section
            data-testid={`block-history-preview-${index}`}
            aria-label={t('history.previewLabel')}
            className="block-history-preview rounded-md border border-border/30 bg-muted/30 p-2 text-block-sm"
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
            ) : diffMode === 'comparedToCurrent' && comparedFailed ? (
              // #1736: the compared-to-current fetch rejected and the guard
              // blocks any re-fetch, so the container would otherwise render
              // nothing. Surface an inline error + retry, mirroring the
              // EmptyState pattern DiffDisplay already uses for empty diffs.
              <div data-testid={`block-history-diff-error-${index}`}>
                <EmptyState
                  compact
                  headingLevel="p"
                  icon={AlertTriangle}
                  message={t('history.loadDiffFailed')}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      data-testid={`block-history-diff-retry-${index}`}
                      onClick={handleRetryComparedDiff}
                    >
                      {t('action.retry')}
                    </Button>
                  }
                />
              </div>
            ) : activeSpans != null ? (
              <DiffDisplay spans={activeSpans} />
            ) : null}
          </div>
        </div>
      )}
    </li>
  )
}
