/**
 * HistorySelectionToolbar --- batch selection toolbar for history view.
 *
 * Appears when one or more history entries are selected.
 * Shows selection count, revert button, clear selection button,
 * and keyboard hint.
 *
 * Extracted from HistoryView for testability.
 */

import { RotateCcw, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { BatchActionToolbar } from '@/components/BatchActionToolbar'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistorySelectionToolbarProps {
  selectedCount: number
  reverting: boolean
  onRevertClick: () => void
  onClearSelection: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistorySelectionToolbar({
  selectedCount,
  reverting,
  onRevertClick,
  onClearSelection,
}: HistorySelectionToolbarProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <BatchActionToolbar
      selectedCount={selectedCount}
      className="history-selection-toolbar gap-3 p-3"
      suppressRangeSelectHint
    >
      <Button
        variant="outline"
        size="sm"
        onClick={onRevertClick}
        disabled={reverting || selectedCount === 0}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {reverting ? t('history.revertingButton') : t('history.revertSelectedButton')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClearSelection}
        disabled={reverting || selectedCount === 0}
      >
        <X className="h-3 w-3" />
        {t('history.clearSelectionButton')}
      </Button>
      <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
        {t('history.keyboardHint')}
      </span>
    </BatchActionToolbar>
  )
}
