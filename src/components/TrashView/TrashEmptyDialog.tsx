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
  itemCount: number
  /**
   * UX-341: When `true`, the loaded `itemCount` understates the true backend
   * count (more pages remain). The dialog switches to copy that doesn't claim
   * an exact number, since `purge_all_deleted` ignores pagination.
   */
  hasMore?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function TrashEmptyDialog({
  open,
  itemCount,
  hasMore = false,
  onOpenChange,
  onConfirm,
}: TrashEmptyDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const description = hasMore
    ? t('trash.emptyTrashDescriptionPaginated', { count: itemCount })
    : t('trash.emptyTrashDescription', { count: itemCount })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('trash.emptyTrashTitle')}
      description={description}
      cancelLabel={t('trash.noButton')}
      actionLabel={t('trash.yesDeleteButton')}
      variant="destructive"
      onConfirm={onConfirm}
      className="trash-empty-confirm"
    />
  )
}
