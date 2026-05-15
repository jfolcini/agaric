/**
 * HistoryListItem --- a single row in the history list.
 *
 * Shows op type badge, timestamp, content summary, word-level diff for edits,
 * and selection checkbox. Supports click/shift-click selection.
 *
 * Extracted from HistoryView for testability.
 *
 * Per the Phase 3b design-system-maintainability plan
 * (`pending/design-system-maintainability-2026-05-09.md`), this file is the
 * orchestrator: the shared `HistoryItemCore` and the per-block-history
 * `BlockHistoryItem` row live as sibling files under
 * `./HistoryListItem/`. The named exports (`opIcon`, `HistoryItemCore`,
 * `HistoryItemCoreProps`, `BlockHistoryItem`, `BlockHistoryItemProps`,
 * `BlockHistoryDiffMode`) are re-exported here so external consumers
 * (`HistoryListView`, `HistoryPanel`, the test file) keep working
 * without import-path churn.
 */

import { Lock, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { DiffDisplay } from './DiffDisplay'
import { HistoryItemCore } from './HistoryListItem/HistoryItemCore'

export type {
  BlockHistoryDiffMode,
  BlockHistoryItemProps,
} from './HistoryListItem/BlockHistoryItem'
export { BlockHistoryItem } from './HistoryListItem/BlockHistoryItem'
export type { HistoryItemCoreProps } from './HistoryListItem/HistoryItemCore'
// Re-export public surface from the extracted siblings so consumers can
// keep importing from `./HistoryListItem`.
export { HistoryItemCore, opIcon } from './HistoryListItem/HistoryItemCore'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistoryListItemProps {
  entry: HistoryEntry
  index: number
  isSelected: boolean
  isFocused: boolean
  isNonReversible: boolean
  isExpanded: boolean
  isLoadingDiff: boolean
  diffSpans: DiffSpan[] | undefined
  onRowClick: (index: number, e: React.MouseEvent) => void
  onToggleSelection: (index: number) => void
  onToggleDiff: (entry: HistoryEntry) => void
  onRestoreToHere: (entry: HistoryEntry) => void
  /**
   * Optional inline `style` (perf-review Tier 2 #6, 2026-05-14) —
   * `@tanstack/react-virtual` consumers in `HistoryListView` apply
   * `position: absolute` + `transform: translateY(...)` so each
   * virtualized row keeps its single `<div role="row">` element without
   * a wrapper that would break the grid row/cell ARIA chain.
   */
  style?: React.CSSProperties
  /** Optional ref forwarded to the row `<div>` for the virtualizer's `measureElement`. */
  rowRef?: (node: HTMLDivElement | null) => void
  /** Forwarded `data-index` so the virtualizer can identify the row when measuring. */
  dataIndex?: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function HistoryListItemInner({
  entry,
  index,
  isSelected,
  isFocused,
  isNonReversible,
  isExpanded,
  isLoadingDiff,
  diffSpans,
  onRowClick,
  onToggleSelection,
  onToggleDiff,
  onRestoreToHere,
  style,
  rowRef,
  dataIndex,
}: HistoryListItemProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid row for history list — no semantic HTML equivalent for nested-action rows
    <div
      ref={rowRef}
      style={style}
      data-index={dataIndex}
      data-history-item
      data-testid={`history-item-${index}`}
      role="row"
      aria-selected={isSelected}
      className={cn(
        'history-item flex flex-col gap-2 rounded-lg border p-4 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50 border-accent' : 'bg-card hover:bg-accent/30',
        isFocused && 'ring-2 ring-ring',
        isNonReversible && 'opacity-50',
      )}
      onClick={(e) => onRowClick(index, e)}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault()
          onToggleSelection(index)
        }
      }}
      tabIndex={isFocused ? 0 : -1}
      aria-disabled={isNonReversible || undefined}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to inner controls */}
      <div role="gridcell" className="flex items-center gap-3 w-full">
        {/* Checkbox.
            UX-275 sub-fix 5: keep both row-click and checkbox-click as active
            selection paths (matches the existing test contract), but surface
            a clearly visible focus-ring on the checkbox so keyboard users
            can see when it owns focus and Space-toggle works deterministically. */}
        <input
          type="checkbox"
          checked={isSelected}
          disabled={isNonReversible}
          onChange={() => onToggleSelection(index)}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'h-4 w-4 shrink-0 rounded border-border [@media(pointer:coarse)]:size-11',
            'focus-ring-visible',
          )}
          aria-label={t('history.selectOperationLabel', {
            opType: entry.op_type,
            seq: entry.seq,
          })}
          data-testid={`history-checkbox-${index}`}
        />

        {/* Shared core content */}
        <HistoryItemCore
          entry={entry}
          isExpanded={isExpanded}
          isLoadingDiff={isLoadingDiff}
          onToggleDiff={onToggleDiff}
        />

        {/* Restore to here button — only for reversible ops.
            UX-275 sub-fix 6: tooltips don't fire on touch (no hover), so an
            icon-only affordance is unlabelled there. The trailing span is
            sr-only on pointer:fine and not-sr-only on pointer:coarse — the
            text appears beside the icon on touch devices only, preserving
            the compact desktop layout. */}
        {!isNonReversible && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="restore-to-here-btn shrink-0 px-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestoreToHere(entry)
                  }}
                  aria-label={t('history.restoreToHereLabel')}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {/* Visible only on touch (pointer:coarse) so SRs that
                      already read aria-label aren't fed a duplicate. */}
                  <span
                    aria-hidden="true"
                    className="hidden [@media(pointer:coarse)]:inline ml-1 text-xs"
                    data-testid="restore-to-here-touch-label"
                  >
                    {t('history.restoreToHereTouchLabel')}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('history.restoreToHereTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Lock icon + visible "Non-reversible" label for non-reversible ops.
            UX-351: opacity-50 alone is a single visual cue (WCAG concern); the
            visible text label adds a second cue for both visual and SR users. */}
        {isNonReversible && (
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
        )}
      </div>
      {isExpanded && diffSpans != null && (
        // biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern
        // biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to inner controls
        <div
          role="gridcell"
          className="diff-container mt-2 w-full"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DiffDisplay spans={diffSpans} />
        </div>
      )}
    </div>
  )
}

export const HistoryListItem = React.memo(HistoryListItemInner)
HistoryListItem.displayName = 'HistoryListItem'
