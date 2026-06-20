/**
 * TrashBatchRestoreDialog — sub-fix 8 confirmation for large
 * batch restores (>5 selected). Mirrors the batch-purge confirmation
 * so the user doesn't unwind a long cascade with a misclick. Sibling
 * Extracted from TrashView.tsx for.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('trash.batchRestoreConfirmTitle', { count: selectedCount })}
      description={t('trash.batchRestoreConfirmDescription', { count: selectedCount })}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.restoreButton')}
      onConfirm={onConfirm}
      className="trash-batch-restore-confirm"
      contentTestId="trash-batch-restore-confirm"
      actionTestId="trash-batch-restore-yes"
      cancelTestId="trash-batch-restore-no"
    />
  )
}
