/**
 * TrashBatchRestoreDialog — sub-fix 8 confirmation for large
 * batch restores (>5 selected). Mirrors the batch-purge confirmation
 * so the user doesn't unwind a long cascade with a misclick. Sibling
 * extracted from TrashView.tsx to keep the orchestrator thin.
 */

import type React from 'react'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

interface TrashBatchRestoreDialogProps {
  open: boolean
  selectedCount: number
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function TrashBatchRestoreDialog({
  open,
  selectedCount,
  onOpenChange,
  onConfirm,
}: TrashBatchRestoreDialogProps): React.ReactElement {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="trash.batchRestoreConfirmTitle"
      descriptionKey="trash.batchRestoreConfirmDescription"
      cancelKey="trash.noButton"
      confirmKey="trash.restoreButton"
      values={{ count: selectedCount }}
      onConfirm={onConfirm}
      className="trash-batch-restore-confirm"
      contentTestId="trash-batch-restore-confirm"
      actionTestId="trash-batch-restore-yes"
      cancelTestId="trash-batch-restore-no"
    />
  )
}
