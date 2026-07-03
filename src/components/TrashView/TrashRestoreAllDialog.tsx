/**
 * TrashRestoreAllDialog — confirms restoring every trashed block to
 * its original location (the `t('trash.restoreAllHeaderButton')`
 * header action). Sibling extracted from TrashView.tsx to keep the
 * orchestrator thin.
 */

import type React from 'react'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

interface TrashRestoreAllDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function TrashRestoreAllDialog({
  open,
  onOpenChange,
  onConfirm,
}: TrashRestoreAllDialogProps): React.ReactElement {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="trash.restoreAllTitle"
      descriptionKey="trash.restoreAllDescription"
      cancelKey="trash.noButton"
      confirmKey="trash.restoreButton"
      onConfirm={onConfirm}
      className="trash-restore-all-confirm"
    />
  )
}
