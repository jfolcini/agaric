/**
 * TrashRestoreAllDialog — confirms restoring every trashed block to
 * its original location (the `t('trash.restoreAllHeaderButton')`
 * Header action). Sibling extracted from TrashView.tsx for.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('trash.restoreAllTitle')}
      description={t('trash.restoreAllDescription')}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.restoreButton')}
      onConfirm={onConfirm}
      className="trash-restore-all-confirm"
    />
  )
}
