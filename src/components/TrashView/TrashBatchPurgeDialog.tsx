/**
 * TrashBatchPurgeDialog — confirms permanently deleting every block in
 * the current selection (the toolbar "Purge selected" flow). Sibling
 * extracted from TrashView.tsx for MAINT-128.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'

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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('trash.batchPurgeTitle', { count: selectedCount })}
      description={t('trash.batchPurgeDescription', { count: selectedCount })}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.yesDeleteButton')}
      actionVariant="destructive"
      onAction={onConfirm}
      className="trash-batch-purge-confirm"
    />
  )
}
