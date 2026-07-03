/**
 * TrashBatchPurgeDialog — confirms permanently deleting every block in
 * the current selection (the toolbar `t('trash.purgeSelectedButton')`
 * flow). Sibling extracted from TrashView.tsx to keep the orchestrator
 * thin.
 */

import type React from 'react'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

interface TrashBatchPurgeDialogProps {
  open: boolean
  selectedCount: number
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function TrashBatchPurgeDialog({
  open,
  selectedCount,
  onOpenChange,
  onConfirm,
}: TrashBatchPurgeDialogProps): React.ReactElement {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="trash.batchPurgeTitle"
      descriptionKey="trash.batchPurgeDescription"
      cancelKey="trash.noButton"
      confirmKey="trash.yesDeleteButton"
      values={{ count: selectedCount }}
      variant="destructive"
      onConfirm={onConfirm}
      className="trash-batch-purge-confirm"
    />
  )
}
