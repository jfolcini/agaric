/**
 * BatchActionToolbar — shared wrapper for batch-action toolbars.
 *
 * Provides the common container (flex, border, bg-muted/50, padding)
 * and a selection count badge. Context-specific action buttons are
 * passed as children.
 *
 * Used by HistorySelectionToolbar and ConflictBatchToolbar.
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BatchActionToolbar({
  selectedCount,
  children,
  className,
}: BatchActionToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="toolbar"
      aria-label={t('batch.selectedCount', { count: selectedCount })}
      className={cn('flex items-center gap-2 rounded-lg border bg-muted/50 p-2', className)}
    >
      <Badge variant="secondary">{t('batch.selectedCount', { count: selectedCount })}</Badge>
      {children}
    </div>
  )
}
