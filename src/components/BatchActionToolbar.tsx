/**
 * BatchActionToolbar — shared wrapper for batch-action toolbars.
 *
 * Provides the common container (flex, border, bg-muted/50, padding)
 * and a selection count badge. Context-specific action buttons are
 * passed as children.
 *
 * Used by HistorySelectionToolbar and ConflictBatchToolbar.
 *
 * UX-260 sub-fix 4: a desktop-only Shift+Click range-select hint is
 * appended to the right of the toolbar, mirroring the
 * HistorySelectionToolbar:63-65 pattern, so the gesture surfaces in
 * every batch context (history, conflicts, trash). Hidden on touch
 * via `hidden sm:inline` so we don't show a desktop-only affordance.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BatchActionToolbarProps {
  selectedCount: number
  children: React.ReactNode
  className?: string
  /**
   * Whether to suppress the Shift+Click range-select hint. Defaults to
   * `false` (hint shown). Callers that already render their own hint
   * (e.g., `TrashView` shipped one in session 483) pass `true` to avoid
   * duplication.
   */
  suppressRangeSelectHint?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BatchActionToolbar({
  selectedCount,
  children,
  className,
  suppressRangeSelectHint,
}: BatchActionToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="toolbar"
      aria-label={t('batch.selectedCount', { count: selectedCount })}
      aria-describedby={!suppressRangeSelectHint ? 'batch-range-select-hint' : undefined}
      className={cn('flex items-center gap-2 rounded-lg border bg-muted/50 p-2', className)}
    >
      <Badge variant="secondary">{t('batch.selectedCount', { count: selectedCount })}</Badge>
      {children}
      {!suppressRangeSelectHint && (
        <span
          id="batch-range-select-hint"
          className="ml-auto hidden text-xs text-muted-foreground sm:inline"
          data-testid="batch-range-select-hint"
        >
          {t('list.rangeSelectHint')}
        </span>
      )}
    </div>
  )
}
