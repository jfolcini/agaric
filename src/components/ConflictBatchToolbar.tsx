/**
 * ConflictBatchToolbar — batch action toolbar for conflict resolution.
 *
 * Shows the selection count badge, select/deselect all toggle, and
 * "Keep all" / "Discard all" action buttons. Appears when one or more
 * conflicts are selected.
 *
 * Extracted from ConflictList.tsx for testability (#651-R3).
 */

import { Check, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export interface ConflictBatchToolbarProps {
  selectedCount: number
  totalCount: number
  onToggleSelectAll: () => void
  onKeepAll: () => void
  onDiscardAll: () => void
}

export function ConflictBatchToolbar({
  selectedCount,
  totalCount,
  onToggleSelectAll,
  onKeepAll,
  onDiscardAll,
}: ConflictBatchToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="conflict-batch-toolbar flex items-center gap-2 rounded-lg border bg-muted/50 p-2 mb-2">
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <Button variant="ghost" size="sm" onClick={onToggleSelectAll}>
        {selectedCount === totalCount
          ? t('conflict.deselectAllButton')
          : t('conflict.selectAllButton')}
      </Button>
      <div className="flex-1" />
      <Button variant="outline" size="sm" onClick={onKeepAll}>
        <Check className="h-3.5 w-3.5 mr-1" />
        {t('conflict.keepAllButton')}
      </Button>
      <Button variant="destructive" size="sm" onClick={onDiscardAll}>
        <X className="h-3.5 w-3.5 mr-1" />
        {t('conflict.discardAllButton')}
      </Button>
    </div>
  )
}
