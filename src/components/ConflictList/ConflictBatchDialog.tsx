/**
 * ConflictBatchDialog — confirms applying Keep/Discard to all selected
 * conflicts (#651-C8). Title and description swap based on the chosen
 * action. Sibling extracted from ConflictList.tsx for MAINT-128.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'

export type ConflictBatchAction = 'keep' | 'discard'

interface ConflictBatchDialogProps {
  action: ConflictBatchAction | null
  selectedCount: number
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function ConflictBatchDialog({
  action,
  selectedCount,
  onOpenChange,
  onConfirm,
}: ConflictBatchDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={!!action}
      onOpenChange={onOpenChange}
      title={
        action === 'keep'
          ? t('conflict.keepAllSelectedTitle')
          : t('conflict.discardAllSelectedTitle')
      }
      description={
        action === 'keep'
          ? t('conflict.batchKeepDescription', { count: selectedCount })
          : t('conflict.batchDiscardDescription', { count: selectedCount })
      }
      cancelLabel={t('dialog.cancel')}
      actionLabel={
        action === 'keep' ? t('conflict.batchKeepAction') : t('conflict.batchDiscardAction')
      }
      actionVariant="destructive"
      onAction={onConfirm}
      className="conflict-batch-confirm"
    />
  )
}
