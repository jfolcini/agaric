/**
 * HistoryListItem --- a single row in the history list.
 *
 * Shows op type badge, timestamp, content summary, word-level diff for edits,
 * and selection checkbox. Supports click/shift-click selection.
 *
 * Extracted from HistoryView for testability.
 */

import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight,
  Circle,
  Lock,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { formatTimestamp } from '../lib/format'
import { getPayloadRawContent, getPropertyPayload } from '../lib/history-utils'
import { logger } from '../lib/logger'
import { formatPropertyName } from '../lib/property-utils'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { computeBlockVsCurrentDiff } from '../lib/tauri'
import { DiffDisplay } from './DiffDisplay'
import { renderRichContent } from './RichContentRenderer'

// ---------------------------------------------------------------------------
// Badge colour mapping
// ---------------------------------------------------------------------------

function opBadgeClasses(opType: string): string {
  if (opType.startsWith('create') || opType.startsWith('restore')) {
    return 'bg-op-create text-op-create-foreground'
  }
  if (opType.startsWith('edit')) {
    return 'bg-op-edit text-op-edit-foreground'
  }
  if (opType.startsWith('delete') || opType.startsWith('purge')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (opType.startsWith('move')) {
    return 'bg-op-move text-op-move-foreground'
  }
  if (
    opType.startsWith('tag') ||
    opType.startsWith('property') ||
    opType === 'set_property' ||
    opType === 'delete_property'
  ) {
    return 'bg-op-tag text-op-tag-foreground'
  }
  if (opType.startsWith('attachment') || opType === 'add_attachment') {
    return 'bg-muted text-muted-foreground'
  }
  return 'bg-secondary text-secondary-foreground'
}

// ---------------------------------------------------------------------------
// Badge icon mapping
// ---------------------------------------------------------------------------

export function opIcon(opType: string): LucideIcon {
  if (opType.startsWith('restore')) return RotateCcw
  if (opType.startsWith('create')) return Plus
  if (opType.startsWith('edit')) return Pencil
  if (opType.startsWith('move')) return ArrowRight
  if (opType === 'add_tag' || opType === 'remove_tag') return Tag
  if (opType === 'set_property' || opType === 'delete_property') return Settings
  if (opType === 'add_attachment' || opType === 'delete_attachment') return Paperclip
  if (opType.startsWith('delete') || opType.startsWith('purge')) return Trash2
  return Circle
}

// ---------------------------------------------------------------------------
// HistoryItemCore — shared visual elements
// ---------------------------------------------------------------------------

export interface HistoryItemCoreProps {
  entry: HistoryEntry
  /** When omitted, the diff-toggle button is hidden (PEND-17 Part B —
   *  `BlockHistoryItem` drives expansion from the row click instead). */
  isExpanded?: boolean
  isLoadingDiff?: boolean
  onToggleDiff?: (entry: HistoryEntry) => void
}

export function HistoryItemCore({
  entry,
  isExpanded,
  isLoadingDiff,
  onToggleDiff,
}: HistoryItemCoreProps): React.ReactElement {
  const { t } = useTranslation()
  const rawContent = getPayloadRawContent(entry)
  const propPayload = getPropertyPayload(entry)
  const richCallbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  return (
    <>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        {/* Op type badge */}
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              'history-item-type shrink-0 border-transparent',
              opBadgeClasses(entry.op_type),
            )}
            data-testid="history-type-badge"
          >
            {(() => {
              const IconComponent = opIcon(entry.op_type)
              return <IconComponent className="h-3 w-3 mr-1" />
            })()}
            {entry.op_type}
          </Badge>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="history-item-time text-xs text-muted-foreground w-fit">
                  {formatTimestamp(entry.created_at, 'relative')}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{formatTimestamp(entry.created_at, 'full')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="text-xs text-muted-foreground"> · </span>
          <span className="history-item-device text-xs text-muted-foreground">
            dev:{entry.device_id.slice(0, 8)}
          </span>
        </div>
        {/* Content preview */}
        {propPayload && (
          <span className="history-item-preview text-sm line-clamp-2">
            {formatPropertyName(propPayload.key)}
            {propPayload.value != null && ` → ${propPayload.value}`}
          </span>
        )}
        {!propPayload && rawContent && (
          <span className="history-item-preview text-sm line-clamp-2">
            {renderRichContent(rawContent, {
              interactive: true,
              onTagClick,
              ...richCallbacks,
            })}
          </span>
        )}
      </div>
      {/* Diff toggle — only when the parent supplies an `onToggleDiff`
          handler. PEND-17 Part B `BlockHistoryItem` omits it and drives
          expansion from the whole-row click target instead. */}
      {entry.op_type === 'edit_block' && onToggleDiff && (
        <Button
          variant="ghost"
          size="sm"
          className="diff-toggle-btn shrink-0 px-2"
          onClick={(e) => {
            e.stopPropagation()
            onToggleDiff(entry)
          }}
        >
          <ChevronToggle
            isExpanded={isExpanded ?? false}
            loading={isLoadingDiff ?? false}
            size="md"
          />
          {t('history.diffButton')}
        </Button>
      )}
    </>
  )
}

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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryListItem({
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
}: HistoryListItemProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid row for history list — no semantic HTML equivalent for nested-action rows
    <div
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
            'focus-ring-visible focus-visible:ring-offset-1',
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

// ---------------------------------------------------------------------------
// BlockHistoryItem — per-block history row with restore-with-preview panel
// ---------------------------------------------------------------------------
//
// PEND-17 Part B: restore-with-preview redesign.
//
// Collapsed: timestamp + relative-age click target on the whole row.
// Expanded (only `edit_block` ops with extractable content qualify):
//
//   1. Top    — primary `Restore this version (timestamp)` button.
//               Click triggers `onRestore(entry)` directly. No
//               ConfirmDialog: HistoryPanel snapshots + offers
//               Undo on the success toast (`UX-275 sub-fix 4`).
//   2. Middle — read-only `RichContentRenderer` showing the historical
//               content as it would appear if restored.
//   3. Bottom — segmented `ToggleGroup` switching between:
//                 • `justThisChange`   — single-step diff (op vs. immediately
//                                        previous version), reuses
//                                        `useHistoryDiffToggle`'s cache.
//                 • `comparedToCurrent` — `compute_block_vs_current_diff`
//                                        IPC fetched lazily on first expand;
//                                        DEFAULT mode (the panel exists to
//                                        support the restore decision).

const DIFF_MODE_DEFAULT: BlockHistoryDiffMode = 'comparedToCurrent'

export type BlockHistoryDiffMode = 'justThisChange' | 'comparedToCurrent'

export interface BlockHistoryItemProps {
  /** Block whose history is being shown. Required for `compute_block_vs_current_diff`. */
  blockId: string
  entry: HistoryEntry
  index: number
  /** Whether the row is expanded. Owned by the parent so keyboard nav can drive it. */
  isExpanded: boolean
  /** Loading state for the "Just this change" diff (single-step). */
  isLoadingDiff: boolean
  /** "Just this change" diff spans (op vs. immediately previous version). */
  diffSpans: DiffSpan[] | undefined
  /** Click on the whole row toggles expansion (only on restorable rows). */
  onExpandToggle: (entry: HistoryEntry, opening: boolean) => void
  /** Direct restore action — toast-with-Undo is the safety net (no ConfirmDialog). */
  onRestore: (entry: HistoryEntry) => void
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: comparedDiff/comparedLoading/comparedFailed are runtime guards, not re-run triggers — see comment above.
  React.useEffect(() => {
    if (!isExpanded || !isRestorable) return
    if (comparedDiff != null || comparedLoading || comparedFailed) return
    let cancelled = false
    setComparedLoading(true)
    computeBlockVsCurrentDiff({ blockId, historicalSeq: entry.seq })
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
        toast.error(t('history.loadDiffFailed'))
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

  const activeSpans = diffMode === 'comparedToCurrent'
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
        // biome-ignore lint/a11y/useSemanticElements: row already contains nested interactive elements (Tooltip-wrapped timestamp, Badge); a real <button> would nest interactives. The keyboard handler + role="button" + aria-expanded is the standard shadcn pattern for this case.
        <div
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
        <div data-testid={`block-history-row-${index}`} className="flex items-center gap-2 w-full">
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
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {t('history.restoreThisVersion', {
              timestamp: formatTimestamp(entry.created_at, 'relative'),
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
