/**
 * TrashEmptyDialog — confirms permanently purging every trashed block
 * (the "Empty trash" header action). Sibling extracted from
 * TrashView.tsx for MAINT-128.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'

interface TrashEmptyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function TrashEmptyDialog({
  open,
  onOpenChange,
  onConfirm,
}: TrashEmptyDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('trash.emptyTrashTitle')}
      description={t('trash.emptyTrashDescription')}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.yesDeleteButton')}
      actionVariant="destructive"
      onAction={onConfirm}
      className="trash-empty-confirm"
    />
  )
}
