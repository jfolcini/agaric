/**
 * TrashPurgeDialog — confirms permanently deleting a single trashed
 * block (the per-row "Purge" flow). Sibling extracted from
 * TrashView.tsx for MAINT-128.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'

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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={!!blockId}
      onOpenChange={onOpenChange}
      title={t('trash.permanentlyDeleteTitle')}
      description={t('trash.permanentlyDeleteDescription')}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.yesDeleteButton')}
      actionVariant="destructive"
      onAction={() => {
        if (blockId) onConfirm(blockId)
      }}
      className="trash-purge-confirm"
      contentTestId="trash-purge-confirm"
      cancelTestId="trash-purge-no"
      actionTestId="trash-purge-yes"
    />
  )
}
