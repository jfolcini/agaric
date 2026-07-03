/**
 * TrashEmptyDialog — confirms permanently purging every trashed block
 * (the `t('trash.emptyTrashButton')` header action). Sibling extracted
 * from TrashView.tsx to keep the orchestrator thin.
 */

import type React from 'react'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

interface TrashEmptyDialogProps {
  open: boolean
  itemCount: number
  /**
   * When `true`, the loaded `itemCount` understates the true backend
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
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="trash.emptyTrashTitle"
      descriptionKey={
        hasMore ? 'trash.emptyTrashDescriptionPaginated' : 'trash.emptyTrashDescription'
      }
      cancelKey="trash.noButton"
      confirmKey="trash.yesDeleteButton"
      values={{ count: itemCount }}
      variant="destructive"
      onConfirm={onConfirm}
      className="trash-empty-confirm"
    />
  )
}
