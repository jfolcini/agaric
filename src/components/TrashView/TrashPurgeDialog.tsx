/**
 * TrashPurgeDialog — confirms permanently deleting a single trashed
 * block (the per-row `t('trash.purgeButton')` flow). Sibling extracted
 * from TrashView.tsx to keep the orchestrator thin.
 */

import type React from 'react'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

interface TrashPurgeDialogProps {
  blockId: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (blockId: string) => void
}

export function TrashPurgeDialog({
  blockId,
  onOpenChange,
  onConfirm,
}: TrashPurgeDialogProps): React.ReactElement {
  return (
    <ConfirmDialog
      open={!!blockId}
      onOpenChange={onOpenChange}
      titleKey="trash.permanentlyDeleteTitle"
      descriptionKey="trash.permanentlyDeleteDescription"
      cancelKey="trash.noButton"
      confirmKey="trash.yesDeleteButton"
      variant="destructive"
      onConfirm={() => {
        if (blockId) onConfirm(blockId)
      }}
      className="trash-purge-confirm"
      contentTestId="trash-purge-confirm"
      cancelTestId="trash-purge-no"
      actionTestId="trash-purge-yes"
    />
  )
}
